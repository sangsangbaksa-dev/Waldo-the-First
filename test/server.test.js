import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { RateLimiter } from '../src/auth.js';
import { createChatServer } from '../src/server.js';
import { ChatService } from '../src/service.js';
import { FakeSupabase, testDb } from './helpers.js';

let server;
let url;
let supabase;
const sockets = [];

before(async () => {
  supabase = new FakeSupabase();
  server = createChatServer({
    service: new ChatService(await testDb()),
    supabase,
    config: { secureCookies: false, allowedDomains: [] },
    signupLimiter: new RateLimiter({ max: 100, windowMs: 60_000 }),
  });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${server.httpServer.address().port}`;
});

after(() => {
  for (const s of sockets) s.close();
  server.io.close();
});

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

function socketFor(cookie) {
  const socket = connect(url, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie } });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

const next = (socket, event, match = () => true) =>
  new Promise((resolve) => {
    const handler = (data) => {
      if (!match(data)) return;
      socket.off(event, handler);
      resolve(data);
    };
    socket.on(event, handler);
  });

test('로그인 없이는 API와 소켓을 쓸 수 없고, 직접 넣은 헤더 없는 요청은 막는다', async () => {
  assert.equal((await fetch(`${url}/api/me`)).status, 401);
  assert.deepEqual(await (await fetch(`${url}/api/session`)).json(), { user: null });
  await assert.rejects(socketFor(''), /unauthorized/);
  const res = await fetch(`${url}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@gmail.com', name: 'x', password: 'password123' }),
  });
  assert.equal(res.status, 403);
});

test('공개 설정에는 Supabase 공개 키만 있고 비밀 키는 없다', async () => {
  const config = await (await fetch(`${url}/api/config`)).json();
  assert.deepEqual(config, { supabase: { url: 'https://test.supabase.co', anonKey: 'anon-key' }, passwordMin: 8 });
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

test('대화, 실시간 메시지, 입력 중, 읽음, 반응이 오간다', async () => {
  const a = await signup('alice@gmail.com', '앨리스');
  const b = await signup('bob@gmail.com', '밥');
  const sa = await socketFor(a.cookie);
  const sb = await socketFor(b.cookie);

  const changed = next(sb, 'conversations:changed');
  const dm = (await a.call('POST', '/api/conversations/direct', { emails: ['bob@gmail.com'] })).body;
  await changed;
  assert.equal(dm.name, '밥');

  const typing = next(sb, 'typing');
  sa.emit('typing', { conversationId: dm.id, typing: true });
  assert.deepEqual(await typing, { conversationId: dm.id, threadId: null, userId: a.user.id, name: '앨리스', typing: true });

  const incoming = next(sb, 'message:new');
  const sent = await a.call('POST', `/api/conversations/${dm.id}/messages`, { body: `<@${b.user.id}> 안녕` });
  assert.equal(sent.status, 201);
  const event = await incoming;
  assert.equal(event.message.body, `<@${b.user.id}> 안녕`);
  assert.deepEqual(event.mentioned, [b.user.id]);

  const list = (await b.call('GET', '/api/conversations')).body;
  assert.equal(list.find((c) => c.id === dm.id).unread, 1);

  const read = next(sa, 'read');
  await b.call('POST', `/api/conversations/${dm.id}/read`);
  assert.equal((await read).userId, b.user.id);

  const updated = next(sa, 'message:update');
  await b.call('POST', `/api/messages/${sent.body.id}/reactions`, { emoji: '❤️' });
  assert.deepEqual((await updated).message.reactions[0].userIds, [b.user.id]);

  const threadUpdate = next(sa, 'message:update', (e) => e.message.id === sent.body.id && e.message.replies.count === 1);
  await b.call('POST', `/api/conversations/${dm.id}/messages`, { body: '답장', threadId: sent.body.id });
  await threadUpdate;
});

test('파일은 Supabase Storage에 올라가고, 대화 멤버만 서명 URL을 받는다', async () => {
  const a = await signup('carol@gmail.com', '캐럴');
  await signup('dave@gmail.com', '데이브');
  const e = await signup('eve@gmail.com', '이브');
  const dm = (await a.call('POST', '/api/conversations/direct', { emails: ['dave@gmail.com'] })).body;

  const upload = await a.call('POST', '/api/uploads', Buffer.from('hello'), {
    'content-type': 'image/png',
    'x-filename': encodeURIComponent('사진.png'),
  });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.filename, '사진.png');
  const stored = [...supabase.files.entries()].find(([path]) => path.endsWith(upload.body.id));
  assert.equal(stored[1].contentType, 'image/png');
  const sent = await a.call('POST', `/api/conversations/${dm.id}/messages`, { attachmentIds: [upload.body.id] });

  const own = await a.call('GET', upload.body.url);
  assert.equal(own.status, 302);
  assert.match(own.headers.get('location'), /^https:\/\/test\.supabase\.co\/storage\/v1\/object\/sign\//);
  const saved = await a.call('GET', `${upload.body.url}?download`);
  assert.equal(saved.status, 200);
  assert.equal(saved.body, 'hello');
  assert.equal(saved.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('사진.png')}`);
  assert.equal((await e.call('GET', upload.body.url)).status, 404);

  // HTML 같은 형식은 Storage에 바이너리로 두고, 받을 때는 내려받기로만 준다.
  const html = await a.call('POST', '/api/uploads', Buffer.from('<script>alert(1)</script>'), {
    'content-type': 'text/html',
    'x-filename': 'x.html',
  });
  assert.equal([...supabase.files.values()].at(-1).contentType, 'application/octet-stream');
  const served = await a.call('GET', html.body.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'application/octet-stream');
  assert.match(served.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''x\.html$/);

  // 메시지를 지우면 Storage에서도 지운다.
  await a.call('DELETE', `/api/messages/${sent.body.id}`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stored[0] && supabase.files.has(stored[0]), false);
});

test('스페이스를 지우면 멤버들에게 알린다', async () => {
  const a = await signup('frank@gmail.com', '프랭크');
  const b = await signup('grace@gmail.com', '그레이스');
  const sb = await socketFor(b.cookie);
  const space = (await a.call('POST', '/api/spaces', { name: '임시', memberEmails: ['grace@gmail.com'] })).body;
  assert.equal((await b.call('DELETE', `/api/conversations/${space.id}`)).status, 403);
  const removed = next(sb, 'conversation:removed');
  assert.equal((await a.call('DELETE', `/api/conversations/${space.id}`)).status, 200);
  assert.deepEqual(await removed, { id: space.id });
});
