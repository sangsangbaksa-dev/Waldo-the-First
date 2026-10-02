import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect } from 'socket.io-client';
import { openDatabase } from '../src/db.js';
import { createChatServer } from '../src/server.js';
import { ChatService } from '../src/service.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
let server;
let url;
let dir;
const sockets = [];

// 구글 토큰 엔드포인트 흉내
function fakeGoogle(claims) {
  return async (endpoint, init) => {
    assert.equal(endpoint, 'https://oauth2.googleapis.com/token');
    assert.equal(new URLSearchParams(init.body).get('code'), 'good-code');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return { ok: true, json: async () => ({ id_token: `x.${payload}.y` }) };
  };
}
let googleClaims;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chat-test-'));
  const service = new ChatService(openDatabase());
  server = createChatServer({
    service,
    uploadDir: join(dir, 'uploads'),
    config: {
      baseUrl: 'http://localhost',
      google: { clientId: CLIENT_ID, clientSecret: 'secret' },
      devLogin: true,
      allowedDomains: [],
    },
    fetchImpl: (...args) => fakeGoogle(googleClaims)(...args),
  });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${server.httpServer.address().port}`;
});

after(() => {
  for (const s of sockets) s.close();
  server.io.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login(email, name) {
  const res = await fetch(`${url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'chat' },
    body: JSON.stringify({ email, name }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${url}${path}`, {
      method,
      headers: { cookie, 'x-requested-with': 'chat', ...(body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text(), headers: r.headers };
  };
  return { user, cookie, call };
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

test('로그인 없이는 API와 소켓을 쓸 수 없다', async () => {
  assert.equal((await fetch(`${url}/api/me`)).status, 401);
  await assert.rejects(socketFor(''), /unauthorized/);
  // 직접 넣은 헤더가 없는 쓰기 요청은 막는다.
  const res = await fetch(`${url}/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@gmail.com', name: 'x' }),
  });
  assert.equal(res.status, 403);
});

test('구글 로그인: state를 확인하고 id_token으로 계정을 만든다', async () => {
  const start = await fetch(`${url}/auth/google`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location'));
  assert.equal(location.host, 'accounts.google.com');
  assert.equal(location.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(location.searchParams.get('scope'), 'openid email profile');
  const state = location.searchParams.get('state');
  const stateCookie = start.headers.get('set-cookie').split(';')[0];

  googleClaims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Date.now() / 1000 + 60,
    email: 'waldo@gmail.com',
    email_verified: true,
    name: '월도',
    picture: 'https://lh3.googleusercontent.com/a/x',
  };

  const bad = await fetch(`${url}/auth/google/callback?code=good-code&state=wrong`, {
    redirect: 'manual',
    headers: { cookie: stateCookie },
  });
  assert.match(decodeURIComponent(bad.headers.get('location')), /error=/);

  const done = await fetch(`${url}/auth/google/callback?code=good-code&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: stateCookie },
  });
  assert.equal(done.headers.get('location'), '/');
  const session = done.headers.get('set-cookie').split(',').map((c) => c.trim()).find((c) => c.startsWith('chat_session='));
  const me = await (await fetch(`${url}/api/me`, { headers: { cookie: session.split(';')[0] } })).json();
  assert.equal(me.email, 'waldo@gmail.com');
  assert.equal(me.name, '월도');

  // 다른 앱용으로 발급된 토큰은 거절한다.
  googleClaims = { ...googleClaims, aud: 'someone-else' };
  const again = await fetch(`${url}/auth/google`, { redirect: 'manual' });
  const s2 = new URL(again.headers.get('location')).searchParams.get('state');
  const rejected = await fetch(`${url}/auth/google/callback?code=good-code&state=${s2}`, {
    redirect: 'manual',
    headers: { cookie: again.headers.get('set-cookie').split(';')[0] },
  });
  assert.match(rejected.headers.get('location'), /error=/);
});

test('대화, 실시간 메시지, 입력 중, 읽음, 반응이 오간다', async () => {
  const a = await login('alice@gmail.com', '앨리스');
  const b = await login('bob@gmail.com', '밥');
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
});

test('파일을 올리고 대화 멤버만 내려받을 수 있다', async () => {
  const a = await login('carol@gmail.com', '캐럴');
  await login('dave@gmail.com', '데이브');
  const e = await login('eve@gmail.com', '이브');
  const dm = (await a.call('POST', '/api/conversations/direct', { emails: ['dave@gmail.com'] })).body;

  const upload = await a.call('POST', '/api/uploads', Buffer.from('hello'), {
    'content-type': 'text/plain',
    'x-filename': encodeURIComponent('메모.txt'),
  });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.filename, '메모.txt');
  await a.call('POST', `/api/conversations/${dm.id}/messages`, { attachmentIds: [upload.body.id] });

  const own = await a.call('GET', upload.body.url);
  assert.equal(own.status, 200);
  assert.equal(own.body, 'hello');
  assert.match(own.headers.get('content-disposition'), /^inline/);
  assert.equal((await e.call('GET', upload.body.url)).status, 404);

  // HTML 같은 형식은 브라우저에서 열리지 않게 내려받기로만 준다.
  const html = await a.call('POST', '/api/uploads', Buffer.from('<script>alert(1)</script>'), {
    'content-type': 'text/html',
    'x-filename': 'x.html',
  });
  const served = await a.call('GET', html.body.url);
  assert.equal(served.headers.get('content-type'), 'application/octet-stream');
  assert.match(served.headers.get('content-disposition'), /^attachment/);
});

test('스페이스를 지우면 멤버들에게 알린다', async () => {
  const a = await login('frank@gmail.com', '프랭크');
  const b = await login('grace@gmail.com', '그레이스');
  const sb = await socketFor(b.cookie);
  const space = (await a.call('POST', '/api/spaces', { name: '임시', memberEmails: ['grace@gmail.com'] })).body;
  assert.equal((await b.call('DELETE', `/api/conversations/${space.id}`)).status, 403);
  const removed = next(sb, 'conversation:removed');
  assert.equal((await a.call('DELETE', `/api/conversations/${space.id}`)).status, 200);
  assert.deepEqual(await removed, { id: space.id });
});
