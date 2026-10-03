import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/auth.js';
import { createChatApp } from '../src/create-app.js';
import { ChatService } from '../src/service.js';
import { FakeRealtime, FakeSupabase, testDb } from './helpers.js';

let server;
let url;
let supabase;
let realtime;

before(async () => {
  supabase = new FakeSupabase();
  realtime = new FakeRealtime();
  const app = createChatApp({
    service: new ChatService(await testDb()),
    supabase,
    realtime,
    config: { secureCookies: false, allowedDomains: [] },
    signupLimiter: new RateLimiter({ max: 100, windowMs: 60_000 }),
  });
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  url = `http://localhost:${server.address().port}`;
});

after(() => server.close());

function client(cookie = '') {
  return async (method, path, body, headers = {}) => {
    const binary = Buffer.isBuffer(body);
    const r = await fetch(`${url}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        cookie,
        'x-requested-with': 'chat',
        ...(body !== undefined && !binary ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text(), headers: r.headers };
  };
}

const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];

async function signup(email, name, password = 'password123') {
  const res = await client()('POST', '/auth/signup', { email, name, password });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const cookie = cookieOf(res);
  return { user: res.body.user, cookie, call: client(cookie) };
}

test('로그인 없이는 API를 쓸 수 없고, 직접 넣은 헤더 없는 요청은 막는다', async () => {
  assert.equal((await fetch(`${url}/api/me`)).status, 401);
  assert.deepEqual(await (await fetch(`${url}/api/session`)).json(), { user: null });
  const res = await fetch(`${url}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@gmail.com', name: 'x', password: 'password123' }),
  });
  assert.equal(res.status, 403);
});

test('공개 설정에는 Supabase 공개 키만 있고 비밀 키는 없다', async () => {
  const config = await (await fetch(`${url}/api/config`)).json();
  assert.deepEqual(config, {
    supabase: { url: 'https://test.supabase.co', anonKey: 'anon-key' },
    bucket: 'chat-attachments',
    passwordMin: 8,
    maxUpload: 25 * 1024 * 1024,
  });
});

test('가입: 실명·이메일·비밀번호로 바로 가입되고 로그인된다', async () => {
  const call = client();
  assert.match((await call('POST', '/auth/signup', { email: 'w@gmail.com', name: '', password: 'password123' })).body.error, /이름/);
  assert.match((await call('POST', '/auth/signup', { email: 'w@gmail.com', name: '월도', password: 'short' })).body.error, /8자/);
  assert.match((await call('POST', '/auth/signup', { email: 'nope', name: '월도', password: 'password123' })).body.error, /이메일/);

  const { user, call: me } = await signup('Waldo@Gmail.com', '김월도');
  assert.equal(user.email, 'waldo@gmail.com');
  assert.equal(user.name, '김월도');
  assert.equal((await me('GET', '/api/me')).body.name, '김월도');
  assert.equal(supabase.accounts.get('waldo@gmail.com').name, '김월도');

  const dup = await call('POST', '/auth/signup', { email: 'waldo@gmail.com', name: '또', password: 'password123' });
  assert.equal(dup.status, 409);
});

test('로그인: 브라우저가 Supabase에서 받은 토큰을 세션으로 바꾼다', async () => {
  await signup('login@gmail.com', '로그인');
  const call = client();
  assert.equal((await call('POST', '/auth/session', { accessToken: 'forged' })).status, 401);

  const token = supabase.signInWithPassword('login@gmail.com', 'password123');
  const res = await call('POST', '/auth/session', { accessToken: token });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.name, '로그인');
  const me = await client(cookieOf(res))('GET', '/api/me');
  assert.equal(me.body.email, 'login@gmail.com');

  const out = await client(cookieOf(res))('POST', '/auth/logout');
  assert.equal(out.status, 200);
  assert.equal((await client(cookieOf(res))('GET', '/api/me')).status, 401);
});

test('비밀번호와 이름 바꾸기', async () => {
  const { call, cookie } = await signup('pw@gmail.com', '비번');
  const otherDevice = cookieOf(await client()('POST', '/auth/session', {
    accessToken: supabase.signInWithPassword('pw@gmail.com', 'password123'),
  }));

  assert.equal((await call('POST', '/api/me/password', { currentPassword: 'wrong-password', newPassword: 'newpassword1' })).status, 400);
  assert.equal((await call('POST', '/api/me/password', { currentPassword: 'password123', newPassword: 'newpassword1' })).status, 200);
  assert.equal(await supabase.verifyPassword('pw@gmail.com', 'newpassword1') !== null, true);
  assert.equal((await client(cookie)('GET', '/api/me')).status, 200); // 지금 기기는 그대로
  assert.equal((await client(otherDevice)('GET', '/api/me')).status, 401); // 다른 기기는 로그아웃

  assert.equal((await call('PATCH', '/api/me', { name: '새 이름' })).body.name, '새 이름');
});

test('대화, 실시간 메시지, 입력 중, 읽음, 반응이 각자의 채널로 간다', async () => {
  const a = await signup('alice@gmail.com', '앨리스');
  const b = await signup('bob@gmail.com', '밥');
  const toA = (event, where) => realtime.next(`user:${a.user.id}`, event, where);
  const toB = (event, where) => realtime.next(`user:${b.user.id}`, event, where);

  const dm = (await a.call('POST', '/api/conversations/direct', { emails: ['bob@gmail.com'] })).body;
  await toB('conversations:changed');
  assert.equal(dm.name, '밥');

  assert.equal((await a.call('POST', `/api/conversations/${dm.id}/typing`, { typing: true })).status, 204);
  assert.deepEqual(await toB('typing'), { conversationId: dm.id, threadId: null, userId: a.user.id, name: '앨리스', typing: true });
  assert.ok(!realtime.sent.some((m) => m.topic === `user:${a.user.id}` && m.event === 'typing'), '입력 중은 본인에게 안 보낸다');

  const sent = await a.call('POST', `/api/conversations/${dm.id}/messages`, { body: `<@${b.user.id}> 안녕` });
  assert.equal(sent.status, 201);
  const event = await toB('message:new');
  assert.equal(event.message.body, `<@${b.user.id}> 안녕`);
  assert.deepEqual(event.mentioned, [b.user.id]);
  await toA('message:new');

  const list = (await b.call('GET', '/api/conversations')).body;
  assert.equal(list.find((c) => c.id === dm.id).unread, 1);

  await b.call('POST', `/api/conversations/${dm.id}/read`);
  assert.equal((await toA('read')).userId, b.user.id);

  await b.call('POST', `/api/messages/${sent.body.id}/reactions`, { emoji: '❤️' });
  assert.deepEqual((await toA('message:update')).message.reactions[0].userIds, [b.user.id]);

  await b.call('POST', `/api/conversations/${dm.id}/messages`, { body: '답장', threadId: sent.body.id });
  await toA('message:update', (p) => p.message.id === sent.body.id && p.message.replies.count === 1);

  // 다른 사람 대화에는 입력 중을 보낼 수 없다.
  const c = await signup('cathy@gmail.com', '캐시');
  assert.equal((await c.call('POST', `/api/conversations/${dm.id}/typing`, { typing: true })).status, 404);

  // 상태 변경은 모두의 채널로 간다.
  await a.call('PATCH', '/api/me/status', { status: 'dnd' });
  assert.deepEqual(await realtime.next('chat:everyone', 'status'), { userId: a.user.id, status: 'dnd', statusText: '' });
});

test('파일은 브라우저가 Storage에 직접 올리고, 대화 멤버만 받을 수 있다', async () => {
  const a = await signup('carol@gmail.com', '캐럴');
  await signup('dave@gmail.com', '데이브');
  const e = await signup('eve@gmail.com', '이브');
  const dm = (await a.call('POST', '/api/conversations/direct', { emails: ['dave@gmail.com'] })).body;

  assert.equal((await a.call('POST', '/api/uploads', { filename: 'big.zip', mime: 'application/zip', size: 26 * 1024 * 1024 })).status, 413);
  assert.equal((await a.call('POST', '/api/uploads', { filename: 'empty', size: 0 })).status, 400);

  const prepared = await a.call('POST', '/api/uploads', { filename: '사진.png', mime: 'image/png', size: 5 });
  assert.equal(prepared.status, 201);
  const { attachment, upload } = prepared.body;
  assert.equal(attachment.filename, '사진.png');
  assert.equal(upload.contentType, 'image/png');
  assert.equal(upload.bucket, 'chat-attachments');

  // 아직 안 올렸으면 보낼 수 없다.
  const early = await a.call('POST', `/api/conversations/${dm.id}/messages`, { attachmentIds: [attachment.id] });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /아직 다 올라가지 않았어/);

  supabase.browserUpload(upload.path, upload.token, Buffer.from('hello'), upload.contentType);
  const sent = await a.call('POST', `/api/conversations/${dm.id}/messages`, { attachmentIds: [attachment.id] });
  assert.equal(sent.status, 201);

  const shown = await a.call('GET', attachment.url);
  assert.equal(shown.status, 302);
  assert.match(shown.headers.get('location'), /^https:\/\/test\.supabase\.co\/storage\/v1\/object\/sign\//);
  const meta = await a.call('GET', `/api/files/${attachment.id}`);
  assert.equal(meta.body.filename, '사진.png');
  assert.match(meta.body.url, /\/object\/sign\//);
  assert.equal((await e.call('GET', attachment.url)).status, 404);
  assert.equal((await e.call('GET', `/api/files/${attachment.id}`)).status, 404);

  // HTML 같은 형식은 Storage에 바이너리로 저장하게 한다.
  const html = await a.call('POST', '/api/uploads', { filename: 'x.html', mime: 'text/html', size: 10 });
  assert.equal(html.body.upload.contentType, 'application/octet-stream');

  // 메시지를 지우면 Storage에서도 지운다.
  await a.call('DELETE', `/api/messages/${sent.body.id}`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(supabase.files.has(upload.path), false);
});

test('스페이스를 지우면 멤버들에게 알린다', async () => {
  const a = await signup('frank@gmail.com', '프랭크');
  const b = await signup('grace@gmail.com', '그레이스');
  const space = (await a.call('POST', '/api/spaces', { name: '임시', memberEmails: ['grace@gmail.com'] })).body;
  assert.equal((await b.call('DELETE', `/api/conversations/${space.id}`)).status, 403);
  assert.equal((await a.call('DELETE', `/api/conversations/${space.id}`)).status, 200);
  assert.deepEqual(await realtime.next(`user:${b.user.id}`, 'conversation:removed'), { id: space.id });
});
