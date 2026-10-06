import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChatService } from '../src/service.js';
import { testDb } from './helpers.js';

async function setup() {
  let t = 1000;
  const service = new ChatService(await testDb(), { now: () => ++t });
  const join = (email, name) => service.linkAccount({ authId: randomUUID(), email, name });
  const a = await join('A@gmail.com', '에이');
  const b = await join('b@gmail.com', '비');
  const c = await join('c@gmail.com', '씨');
  return { service, join, a, b, c };
}

test('가입하면 이메일을 소문자로 저장하고, 같은 Supabase 계정은 같은 사람으로 이어진다', async () => {
  const { service, a } = await setup();
  assert.equal(a.email, 'a@gmail.com');
  assert.equal(a.registered, true);
  const authId = await service.authIdOf(a.id);
  const again = await service.linkAccount({ authId, email: 'a@gmail.com', name: '다른이름' });
  assert.equal(again.id, a.id);
  assert.equal(again.name, '에이'); // 다시 로그인해도 이름은 그대로
  await assert.rejects(service.linkAccount({ authId: randomUUID(), email: 'nope', name: 'x' }), /이메일/);
  await assert.rejects(service.linkAccount({ authId: randomUUID(), email: 'x@y.com', name: '   ' }), /이름/);
  assert.equal((await service.updateProfile(a.id, { name: '  에이  플러스 ' })).name, '에이 플러스');
});

test('1:1 대화는 같은 두 사람 사이에 하나만 생긴다', async () => {
  const { service, a, b } = await setup();
  const first = await service.openDirect(a.id, ['b@gmail.com']);
  const second = await service.openDirect(b.id, ['A@gmail.com']);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.conversation.id, second.conversation.id);
  assert.equal(first.conversation.kind, 'dm');
  assert.equal(first.conversation.name, '비');
});

test('아직 가입 안 한 사람도 이메일로 초대하고, 나중에 가입하면 이어진다', async () => {
  const { service, join, a } = await setup();
  const { conversation } = await service.openDirect(a.id, ['new@gmail.com']);
  assert.equal(await service.emailRegistered('new@gmail.com'), false);
  const later = await join('new@gmail.com', '새친구');
  assert.equal(later.name, '새친구');
  assert.equal((await service.listConversations(later.id))[0].id, conversation.id);
});

test('그룹 대화와 스페이스, 멤버 관리', async () => {
  const { service, a, b, c } = await setup();
  const group = (await service.openDirect(a.id, ['b@gmail.com', 'c@gmail.com'])).conversation;
  assert.equal(group.kind, 'group');

  const space = await service.createSpace(a.id, { name: '공부방', memberEmails: ['b@gmail.com'] });
  assert.equal(space.role, 'manager');
  await assert.rejects(service.updateSpace(b.id, space.id, { name: 'x' }), /관리자/);
  await service.addMembers(b.id, space.id, ['c@gmail.com']);
  assert.equal((await service.members(space.id)).length, 3);
  await assert.rejects(service.removeMember(b.id, space.id, c.id), /관리자/);
  await service.removeMember(a.id, space.id, c.id);
  assert.equal((await service.members(space.id)).length, 2);
  await assert.rejects(service.setRole(a.id, space.id, a.id, 'member'), /한 명 이상/);

  // 마지막 관리자가 나가면 다른 사람이 관리자가 된다.
  await service.removeMember(a.id, space.id, a.id);
  assert.equal((await service.members(space.id))[0].role, 'manager');
  await assert.rejects(service.getConversation(a.id, space.id), /찾을 수 없어/);
});

test('공개 스페이스는 찾아서 참여할 수 있고 비공개는 안 보인다', async () => {
  const { service, a, b } = await setup();
  const open = await service.createSpace(a.id, { name: '공개방', visibility: 'public' });
  await service.createSpace(a.id, { name: '비밀방' });
  assert.deepEqual((await service.listPublicSpaces(b.id)).map((s) => s.name), ['공개방']);
  await service.joinSpace(b.id, open.id);
  assert.equal((await service.listPublicSpaces(b.id)).length, 0);
});

test('메시지, 스레드, 멘션, 안 읽음 수', async () => {
  const { service, a, b, c } = await setup();
  const space = await service.createSpace(a.id, { name: '팀', memberEmails: ['b@gmail.com'] });
  const { message, mentioned } = await service.sendMessage(a.id, space.id, { body: `안녕 <@${b.id}> <@${c.id}>` });
  assert.deepEqual(mentioned, [b.id]); // 멤버가 아닌 씨는 멘션되지 않는다.
  assert.equal(message.mentions[b.id], '비');

  const bView = await service.getConversation(b.id, space.id);
  assert.equal(bView.unread, 1);
  assert.equal(bView.mentionCount, 1);

  await service.sendMessage(b.id, space.id, { body: '답장', threadId: message.id });
  const thread = (await service.listMessages(b.id, space.id, { threadId: message.id })).messages;
  assert.deepEqual(thread.map((m) => m.body), [message.body, '답장']);
  const main = (await service.listMessages(a.id, space.id)).messages.filter((m) => m.kind === 'user');
  assert.equal(main.length, 1);
  assert.equal(main[0].replies.count, 1);
  assert.equal(main[0].replies.people[0].name, '비');

  await service.markRead(b.id, space.id);
  assert.equal((await service.getConversation(b.id, space.id)).unread, 0);
  assert.equal((await service.listMentions(b.id)).length, 1);

  const all = await service.sendMessage(a.id, space.id, { body: '<@all> 모여' });
  assert.deepEqual(all.mentioned, [b.id]);
});

test('오래된 메시지는 50개씩 나눠 받는다', async () => {
  const { service, a } = await setup();
  const dm = (await service.openDirect(a.id, ['b@gmail.com'])).conversation;
  for (let i = 0; i < 55; i++) await service.sendMessage(a.id, dm.id, { body: `m${i}` });
  const first = await service.listMessages(a.id, dm.id);
  assert.equal(first.messages.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(first.messages.at(-1).body, 'm54');
  const older = await service.listMessages(a.id, dm.id, { before: first.messages[0].createdAt });
  assert.deepEqual(older.messages.map((m) => m.body), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.equal(older.hasMore, false);
});

test('수정, 삭제, 반응, 별표, 검색', async () => {
  const { service, a, b } = await setup();
  const dm = (await service.openDirect(a.id, ['b@gmail.com'])).conversation;
  const { message } = await service.sendMessage(a.id, dm.id, { body: '점심 뭐 먹지' });

  await assert.rejects(service.editMessage(b.id, message.id, 'x'), /내가 보낸 메시지만/);
  assert.equal((await service.editMessage(a.id, message.id, '저녁 뭐 먹지')).body, '저녁 뭐 먹지');

  let reacted = await service.toggleReaction(b.id, message.id, '👍');
  assert.deepEqual(reacted.reactions.map((r) => [r.emoji, r.count, r.mine]), [['👍', 1, true]]);
  reacted = await service.toggleReaction(b.id, message.id, '👍');
  assert.equal(reacted.reactions.length, 0);

  assert.equal((await service.toggleStar(b.id, message.id)).starred, true);
  assert.equal((await service.listStarred(b.id)).length, 1);

  assert.equal((await service.search(b.id, '저녁')).length, 1);
  assert.equal((await service.search(b.id, '저녁', { conversationId: dm.id })).length, 1);
  assert.equal((await service.search(b.id, '100%')).length, 0);

  await assert.rejects(service.deleteMessage(b.id, message.id), /삭제할 수 없어요/);
  const deleted = (await service.deleteMessage(a.id, message.id)).message;
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.body, '');
  assert.equal((await service.search(b.id, '저녁')).length, 0);
});

test('첨부 파일은 대화 멤버만 볼 수 있다', async () => {
  const { service, a, b, c } = await setup();
  const dm = (await service.openDirect(a.id, ['b@gmail.com'])).conversation;
  const file = await service.createAttachment(a.id, { filename: 'x.png', mime: 'image/png', size: 3, path: 'p/x' });
  await assert.rejects(service.attachmentFor(b.id, file.id), /찾을 수 없어/);
  const { message } = await service.sendMessage(a.id, dm.id, { attachmentIds: [file.id] });
  assert.equal(message.attachments[0].filename, 'x.png');
  assert.ok(await service.attachmentFor(b.id, file.id));
  await assert.rejects(service.attachmentFor(c.id, file.id), /찾을 수 없어/);
  // 남의 첨부를 가로채 보내거나, 이미 보낸 첨부를 다시 쓸 수 없다.
  const other = await service.createAttachment(c.id, { filename: 'y', mime: 'text/plain', size: 1, path: 'p/y' });
  await assert.rejects(service.sendMessage(a.id, dm.id, { attachmentIds: [other.id] }), /첨부/);
  await assert.rejects(service.sendMessage(a.id, dm.id, { attachmentIds: [file.id] }), /첨부/);
});

test('숨긴 대화는 새 메시지가 오면 다시 보인다', async () => {
  const { service, a, b } = await setup();
  const dm = (await service.openDirect(a.id, ['b@gmail.com'])).conversation;
  await service.setPreferences(b.id, dm.id, { hidden: true, muted: true });
  assert.equal((await service.getConversation(b.id, dm.id)).hidden, true);
  await service.sendMessage(a.id, dm.id, { body: '야' });
  const view = await service.getConversation(b.id, dm.id);
  assert.equal(view.hidden, false);
  assert.equal(view.muted, true);
});

test('세션: 만료되면 쓸 수 없고, 비밀번호를 바꾸면 다른 기기 세션은 지운다', async () => {
  let now = 0;
  const service = new ChatService(await testDb(), { now: () => now });
  const user = await service.linkAccount({ authId: randomUUID(), email: 's@gmail.com', name: '에스' });
  const one = await service.createSession(user.id, 1000);
  const two = await service.createSession(user.id, 1000);
  assert.equal((await service.userForSession(one)).id, user.id);
  await service.deleteOtherSessions(user.id, one);
  assert.equal(await service.userForSession(two), null);
  now = 2000;
  assert.equal(await service.userForSession(one), null);
});

test('인용 답장: 같은 대화의 메시지만 인용하고, 원래 메시지 요약이 붙는다', async () => {
  const { service, a, b } = await setup();
  const dm = (await service.openDirect(a.id, ['b@gmail.com'])).conversation;
  const other = (await service.openDirect(a.id, ['c@gmail.com'])).conversation;
  const { message: original } = await service.sendMessage(b.id, dm.id, { body: `<@${a.id}> 내일 발표 자료 있어요?` });
  const { message: reply } = await service.sendMessage(a.id, dm.id, { body: '네, 보내 드릴게요', quoteId: original.id });
  assert.deepEqual(
    { author: reply.quote.author, body: reply.quote.body, deleted: reply.quote.deleted },
    { author: '비', body: '@에이 내일 발표 자료 있어요?', deleted: false },
  );
  await assert.rejects(service.sendMessage(a.id, other.id, { body: 'x', quoteId: original.id }), /인용할 수 없는/);
  await service.deleteMessage(b.id, original.id);
  const [, after] = (await service.listMessages(a.id, dm.id)).messages.filter((m) => m.kind === 'user');
  assert.equal(after.quote.deleted, true);
  assert.equal(after.quote.body, '');
});

test('전달: 두 대화의 멤버여야 하고, 멘션은 글자로 바뀌고 원래 작성자를 남긴다', async () => {
  const { service, a, b, c } = await setup();
  const dm = (await service.openDirect(a.id, ['b@gmail.com'])).conversation;
  const space = await service.createSpace(a.id, { name: '팀', memberEmails: ['c@gmail.com'] });
  const { message } = await service.sendMessage(b.id, dm.id, { body: `<@${a.id}> 공지 확인해 주세요` });
  const prepared = await service.prepareForward(a.id, message.id, space.id);
  assert.equal(prepared.body, '@에이 공지 확인해 주세요');
  assert.equal(prepared.forwardedFrom, '비');
  const { message: forwarded, mentioned } = await service.sendMessage(a.id, space.id, { body: prepared.body }, { forwardedFrom: prepared.forwardedFrom });
  assert.equal(forwarded.forwardedFrom, '비');
  assert.deepEqual(mentioned, []);
  // 전달할 곳의 멤버가 아니면 안 된다.
  await assert.rejects(service.prepareForward(b.id, message.id, space.id), /찾을 수 없어요/);
  // 다시 전달해도 처음 작성자가 남는다.
  assert.equal((await service.prepareForward(c.id, forwarded.id, space.id)).forwardedFrom, '비');
});

test('메시지 고정: 고정/해제, 목록, 삭제하면 고정도 풀린다', async () => {
  const { service, a, b } = await setup();
  const dm = (await service.openDirect(a.id, ['b@gmail.com'])).conversation;
  const { message: m1 } = await service.sendMessage(a.id, dm.id, { body: '공지 1' });
  const { message: m2 } = await service.sendMessage(b.id, dm.id, { body: '공지 2' });
  assert.equal((await service.togglePin(a.id, m1.id)).pinned, true);
  assert.equal((await service.togglePin(b.id, m2.id)).pinned, true);
  const pins = await service.listPins(a.id, dm.id);
  assert.deepEqual(pins.map((p) => [p.body, p.pinnedBy]), [['공지 2', '비'], ['공지 1', '에이']]);
  assert.equal((await service.getConversation(a.id, dm.id)).pinnedCount, 2);
  assert.equal((await service.togglePin(a.id, m1.id)).pinned, false);
  await service.deleteMessage(b.id, m2.id);
  assert.equal((await service.listPins(a.id, dm.id)).length, 0);
  await assert.rejects(service.togglePin(a.id, m2.id), /고정할 수 없는/);
});

test('프로필 사진: 경로를 저장하고, 화면에는 권한을 확인하는 주소로 준다', async () => {
  const { service, a } = await setup();
  const first = await service.setAvatar(a.id, `avatars/${a.id}/one`);
  assert.equal(first.oldPath, null);
  assert.match(first.user.avatar, new RegExp(`^/avatars/${a.id}\\?v=`));
  const second = await service.setAvatar(a.id, `avatars/${a.id}/two`);
  assert.equal(second.oldPath, `avatars/${a.id}/one`);
  assert.equal(await service.avatarPath(a.id), `avatars/${a.id}/two`);
  const cleared = await service.setAvatar(a.id, null);
  assert.equal(cleared.user.avatar, null);
});

test('이름 받침에 맞춰 로/으로를 고른다', async () => {
  const { withRo } = await import('../src/service.js');
  assert.equal(withRo('폐급'), '으로');
  assert.equal(withRo('교실'), '로');
  assert.equal(withRo('우리 반'), '으로');
  assert.equal(withRo('MSG(맛소금, 미친 학생 그룹)'), '으로');
  assert.equal(withRo('스터디'), '로');
  assert.equal(withRo('3반 1'), '로');
});
