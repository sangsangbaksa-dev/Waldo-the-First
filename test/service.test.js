import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { ChatService } from '../src/service.js';

function setup() {
  let t = 1000;
  const service = new ChatService(openDatabase(), { now: () => ++t });
  const a = service.signIn({ email: 'A@gmail.com', name: '에이' });
  const b = service.signIn({ email: 'b@gmail.com', name: '비' });
  const c = service.signIn({ email: 'c@gmail.com', name: '씨' });
  return { service, a, b, c };
}

test('로그인하면 이메일을 소문자로 저장하고, 다시 로그인하면 정보만 바뀐다', () => {
  const { service, a } = setup();
  assert.equal(a.email, 'a@gmail.com');
  const again = service.signIn({ email: 'a@gmail.com', name: '에이2', avatar: 'x' });
  assert.equal(again.id, a.id);
  assert.equal(again.name, '에이2');
  assert.throws(() => service.signIn({ email: 'not-an-email', name: 'x' }), /이메일/);
});

test('1:1 대화는 같은 두 사람 사이에 하나만 생긴다', () => {
  const { service, a, b } = setup();
  const first = service.openDirect(a.id, ['b@gmail.com']);
  const second = service.openDirect(b.id, ['A@gmail.com']);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.conversation.id, second.conversation.id);
  assert.equal(first.conversation.kind, 'dm');
  assert.equal(first.conversation.name, '비');
});

test('아직 가입 안 한 사람도 이메일로 초대하고, 나중에 로그인하면 이어진다', () => {
  const { service, a } = setup();
  const { conversation } = service.openDirect(a.id, ['new@gmail.com']);
  const later = service.signIn({ email: 'new@gmail.com', name: '새친구' });
  assert.equal(service.listConversations(later.id)[0].id, conversation.id);
});

test('그룹 대화와 스페이스, 멤버 관리', () => {
  const { service, a, b, c } = setup();
  const group = service.openDirect(a.id, ['b@gmail.com', 'c@gmail.com']).conversation;
  assert.equal(group.kind, 'group');

  const space = service.createSpace(a.id, { name: '공부방', memberEmails: ['b@gmail.com'] });
  assert.equal(space.role, 'manager');
  assert.throws(() => service.updateSpace(b.id, space.id, { name: 'x' }), /관리자/);
  service.addMembers(b.id, space.id, ['c@gmail.com']);
  assert.equal(service.members(space.id).length, 3);
  assert.throws(() => service.removeMember(b.id, space.id, c.id), /관리자/);
  service.removeMember(a.id, space.id, c.id);
  assert.equal(service.members(space.id).length, 2);

  // 마지막 관리자가 나가면 다른 사람이 관리자가 된다.
  service.removeMember(a.id, space.id, a.id);
  assert.equal(service.members(space.id)[0].role, 'manager');
  assert.throws(() => service.getConversation(a.id, space.id), /찾을 수 없어/);
});

test('공개 스페이스는 찾아서 참여할 수 있고 비공개는 안 보인다', () => {
  const { service, a, b } = setup();
  const open = service.createSpace(a.id, { name: '공개방', visibility: 'public' });
  service.createSpace(a.id, { name: '비밀방' });
  assert.deepEqual(service.listPublicSpaces(b.id).map((s) => s.name), ['공개방']);
  service.joinSpace(b.id, open.id);
  assert.equal(service.listPublicSpaces(b.id).length, 0);
});

test('메시지, 스레드, 멘션, 안 읽음 수', () => {
  const { service, a, b, c } = setup();
  const space = service.createSpace(a.id, { name: '팀', memberEmails: ['b@gmail.com'] });
  const { message, mentioned } = service.sendMessage(a.id, space.id, { body: `안녕 <@${b.id}> <@${c.id}>` });
  assert.deepEqual(mentioned, [b.id]); // 멤버가 아닌 씨는 멘션되지 않는다.
  assert.equal(message.mentions[b.id], '비');

  const bView = service.getConversation(b.id, space.id);
  assert.equal(bView.unread, 1);
  assert.equal(bView.mentionCount, 1);

  service.sendMessage(b.id, space.id, { body: '답장', threadId: message.id });
  const thread = service.listMessages(b.id, space.id, { threadId: message.id }).messages;
  assert.deepEqual(thread.map((m) => m.body), [message.body, '답장']);
  const main = service.listMessages(a.id, space.id).messages.filter((m) => m.kind === 'user');
  assert.equal(main.length, 1);
  assert.equal(main[0].replies.count, 1);

  service.markRead(b.id, space.id);
  assert.equal(service.getConversation(b.id, space.id).unread, 0);
  assert.equal(service.listMentions(b.id).length, 1);

  const all = service.sendMessage(a.id, space.id, { body: '<@all> 모여' });
  assert.deepEqual(all.mentioned, [b.id]);
});

test('수정, 삭제, 반응, 별표, 검색', () => {
  const { service, a, b } = setup();
  const dm = service.openDirect(a.id, ['b@gmail.com']).conversation;
  const { message } = service.sendMessage(a.id, dm.id, { body: '점심 뭐 먹지' });

  assert.throws(() => service.editMessage(b.id, message.id, 'x'), /내 메시지/);
  assert.equal(service.editMessage(a.id, message.id, '저녁 뭐 먹지').body, '저녁 뭐 먹지');

  let reacted = service.toggleReaction(b.id, message.id, '👍');
  assert.deepEqual(reacted.reactions.map((r) => [r.emoji, r.count, r.mine]), [['👍', 1, true]]);
  reacted = service.toggleReaction(b.id, message.id, '👍');
  assert.equal(reacted.reactions.length, 0);

  assert.equal(service.toggleStar(b.id, message.id).starred, true);
  assert.equal(service.listStarred(b.id).length, 1);

  assert.equal(service.search(b.id, '저녁').length, 1);
  assert.equal(service.search(b.id, '100%').length, 0);

  assert.throws(() => service.deleteMessage(b.id, message.id), /지울 수 없어/);
  const deleted = service.deleteMessage(a.id, message.id).message;
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.body, '');
  assert.equal(service.search(b.id, '저녁').length, 0);
});

test('첨부 파일은 대화 멤버만 볼 수 있다', () => {
  const { service, a, b, c } = setup();
  const dm = service.openDirect(a.id, ['b@gmail.com']).conversation;
  const file = service.createAttachment(a.id, { filename: 'x.png', mime: 'image/png', size: 3, path: '/tmp/x' });
  assert.throws(() => service.attachmentFor(b.id, file.id), /찾을 수 없어/);
  const { message } = service.sendMessage(a.id, dm.id, { attachmentIds: [file.id] });
  assert.equal(message.attachments[0].filename, 'x.png');
  assert.ok(service.attachmentFor(b.id, file.id));
  assert.throws(() => service.attachmentFor(c.id, file.id), /찾을 수 없어/);
  // 남의 첨부를 가로채 보낼 수 없다.
  const other = service.createAttachment(c.id, { filename: 'y', mime: 'text/plain', size: 1, path: '/tmp/y' });
  assert.throws(() => service.sendMessage(a.id, dm.id, { attachmentIds: [other.id] }), /첨부/);
});

test('숨긴 대화는 새 메시지가 오면 다시 보인다', () => {
  const { service, a, b } = setup();
  const dm = service.openDirect(a.id, ['b@gmail.com']).conversation;
  service.setPreferences(b.id, dm.id, { hidden: true, muted: true });
  assert.equal(service.getConversation(b.id, dm.id).hidden, true);
  service.sendMessage(a.id, dm.id, { body: '야' });
  const view = service.getConversation(b.id, dm.id);
  assert.equal(view.hidden, false);
  assert.equal(view.muted, true);
});
