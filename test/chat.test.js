import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatStore,
  LIMITS,
  RateLimiter,
  validateMessage,
  validateNickname,
  validateRoomName,
} from '../src/chat.js';

test('닉네임과 방 이름은 공백을 정리하고 길이를 본다', () => {
  assert.deepEqual(validateNickname('  월   도 '), { value: '월 도' });
  assert.ok(validateNickname('   ').error);
  assert.ok(validateNickname(42).error);
  assert.ok(validateNickname('a'.repeat(LIMITS.nickname + 1)).error);
  assert.deepEqual(validateRoomName(' 공부 '), { value: '공부' });
  assert.ok(validateRoomName('a'.repeat(LIMITS.roomName + 1)).error);
});

test('메시지는 줄바꿈을 살리고 빈 값과 긴 값을 막는다', () => {
  assert.deepEqual(validateMessage('  안녕\n반가워  '), { value: '안녕\n반가워' });
  assert.ok(validateMessage(' \n ').error);
  assert.ok(validateMessage('a'.repeat(LIMITS.message + 1)).error);
});

test('같은 방에 같은 닉네임은 못 들어온다', () => {
  const store = new ChatStore();
  assert.ok(store.join('a', '월도', '로비').room);
  assert.ok(store.join('b', '월도', '로비').error);
  assert.ok(store.join('b', '월도', '잡담').room);
  // 자기 자신이 다시 들어오는 건 괜찮다.
  assert.ok(store.join('a', '월도', '로비').room);
});

test('사람이 다 나간 새 방은 지우고 기본 방은 남긴다', () => {
  const store = new ChatStore({ defaultRooms: ['로비'] });
  store.join('a', '월도', '비밀방');
  assert.deepEqual(store.listRooms(), [
    { name: '로비', users: 0 },
    { name: '비밀방', users: 1 },
  ]);
  assert.equal(store.leave('a', '비밀방'), '월도');
  assert.equal(store.getRoom('비밀방'), undefined);

  store.join('a', '월도', '로비');
  store.leave('a', '로비');
  assert.ok(store.getRoom('로비'));
});

test('기록은 정해 둔 개수만 남긴다', () => {
  const store = new ChatStore({ defaultRooms: ['로비'], historyLimit: 3 });
  for (let i = 1; i <= 5; i++) store.addMessage('로비', { nickname: '월도', text: String(i) });
  assert.deepEqual(store.getRoom('로비').history.map((m) => m.text), ['3', '4', '5']);
  assert.equal(store.addMessage('없는방', { text: 'x' }), null);
});

test('짧은 시간에 너무 많이 보내면 막는다', () => {
  let now = 0;
  const limiter = new RateLimiter({ max: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  assert.equal(limiter.allow('b'), true);
  now = 1000;
  assert.equal(limiter.allow('a'), true);
});
