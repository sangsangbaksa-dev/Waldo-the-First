import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createChatServer } from '../src/server.js';

let server;
let url;
const clients = [];

before(async () => {
  server = createChatServer();
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${server.httpServer.address().port}`;
});

after(async () => {
  for (const client of clients) client.close();
  server.io.close();
});

async function client() {
  const socket = connect(url, { transports: ['websocket'], forceNew: true });
  clients.push(socket);
  await new Promise((resolve) => socket.on('connect', resolve));
  return socket;
}

const emit = (socket, event, payload) => socket.emitWithAck(event, payload);
const next = (socket, event, match = () => true) =>
  new Promise((resolve) => {
    const handler = (data) => {
      if (!match(data)) return;
      socket.off(event, handler);
      resolve(data);
    };
    socket.on(event, handler);
  });

test('정적 페이지와 API가 뜬다', async () => {
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Waldo Chat/);
  const rooms = await (await fetch(`${url}/api/rooms`)).json();
  assert.deepEqual(rooms.map((r) => r.name), ['로비', '잡담', '공부']);
});

test('같은 방 사람끼리 메시지를 주고받는다', async () => {
  const a = await client();
  const b = await client();

  const joinedA = await emit(a, 'join', { nickname: '에이', room: '로비' });
  assert.equal(joinedA.room, '로비');
  assert.deepEqual(joinedA.users, ['에이']);

  const userUpdate = next(a, 'users', (users) => users.length === 2);
  const joinedB = await emit(b, 'join', { nickname: '비', room: '로비' });
  assert.ok(joinedB.history.some((m) => m.type === 'system' && m.text.includes('에이')));
  assert.deepEqual((await userUpdate).sort(), ['비', '에이']);

  const typing = next(b, 'typing');
  a.emit('typing', true);
  assert.deepEqual(await typing, { nickname: '에이', typing: true });

  const received = next(b, 'message', (m) => m.type === 'user');
  const sent = await emit(a, 'message', { text: '  안녕!  ' });
  const message = await received;
  assert.deepEqual(sent, { ok: true, id: message.id });
  assert.equal(message.nickname, '에이');
  assert.equal(message.text, '안녕!');
});

test('방에 안 들어갔거나 잘못된 값이면 거절한다', async () => {
  const a = await client();
  assert.ok((await emit(a, 'message', { text: 'hi' })).error);
  assert.ok((await emit(a, 'join', { nickname: '', room: '로비' })).error);
  assert.ok((await emit(a, 'join', { nickname: '씨', room: '' })).error);

  await emit(a, 'join', { nickname: '씨', room: '잡담' });
  const b = await client();
  assert.match((await emit(b, 'join', { nickname: '씨', room: '잡담' })).error, /닉네임/);
});

test('방을 옮기면 이전 방 사람들에게 알리고 새 방은 목록에 보인다', async () => {
  const a = await client();
  const b = await client();
  await emit(a, 'join', { nickname: '디', room: '공부' });
  await emit(b, 'join', { nickname: '이', room: '공부' });

  const left = next(b, 'message', (m) => m.type === 'system' && m.text.includes('디 님이 나갔어'));
  const rooms = next(b, 'rooms', (list) => list.some((r) => r.name === '새방' && r.users === 1));
  const moved = await emit(a, 'join', { nickname: '디', room: '새방' });
  assert.equal(moved.room, '새방');
  await left;
  await rooms;

  // 사람이 다 나가면 새 방은 사라진다.
  const gone = next(b, 'rooms', (list) => !list.some((r) => r.name === '새방'));
  a.close();
  await gone;
});
