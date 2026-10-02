import { randomUUID } from 'node:crypto';

export const LIMITS = {
  nickname: 20,
  roomName: 30,
  message: 500,
  history: 100,
};

export const DEFAULT_ROOMS = ['로비', '잡담', '공부'];

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function validateNickname(value) {
  const name = clean(value);
  if (!name) return { error: '닉네임을 입력해 줘.' };
  if (name.length > LIMITS.nickname) return { error: `닉네임은 ${LIMITS.nickname}자까지야.` };
  return { value: name };
}

export function validateRoomName(value) {
  const name = clean(value);
  if (!name) return { error: '방 이름을 입력해 줘.' };
  if (name.length > LIMITS.roomName) return { error: `방 이름은 ${LIMITS.roomName}자까지야.` };
  return { value: name };
}

export function validateMessage(value) {
  // 메시지 안의 줄바꿈은 살리고 앞뒤 공백만 걷어 낸다.
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { error: '빈 메시지는 보낼 수 없어.' };
  if (text.length > LIMITS.message) return { error: `메시지는 ${LIMITS.message}자까지야.` };
  return { value: text };
}

/**
 * 방, 접속자, 최근 메시지를 메모리에 들고 있는 저장소.
 * 서버가 다시 켜지면 비워진다.
 */
export class ChatStore {
  constructor({ defaultRooms = DEFAULT_ROOMS, historyLimit = LIMITS.history, now = Date.now } = {}) {
    this.historyLimit = historyLimit;
    this.now = now;
    this.rooms = new Map();
    this.defaultRooms = new Set(defaultRooms);
    for (const name of defaultRooms) this.#createRoom(name);
  }

  #createRoom(name) {
    const room = { name, users: new Map(), history: [] };
    this.rooms.set(name, room);
    return room;
  }

  listRooms() {
    return [...this.rooms.values()].map((room) => ({ name: room.name, users: room.users.size }));
  }

  getRoom(name) {
    return this.rooms.get(name);
  }

  usersIn(name) {
    const room = this.rooms.get(name);
    return room ? [...room.users.values()].sort((a, b) => a.localeCompare(b, 'ko')) : [];
  }

  isTaken(roomName, nickname, socketId) {
    const room = this.rooms.get(roomName);
    if (!room) return false;
    return [...room.users.entries()].some(([id, name]) => id !== socketId && name === nickname);
  }

  join(socketId, nickname, roomName) {
    if (this.isTaken(roomName, nickname, socketId)) return { error: '이 방에 같은 닉네임이 이미 있어.' };
    const room = this.rooms.get(roomName) ?? this.#createRoom(roomName);
    room.users.set(socketId, nickname);
    return { room };
  }

  leave(socketId, roomName) {
    const room = this.rooms.get(roomName);
    if (!room) return null;
    const nickname = room.users.get(socketId);
    room.users.delete(socketId);
    // 사람이 다 나간 사용자 방은 정리한다. 기본 방은 남긴다.
    if (room.users.size === 0 && !this.defaultRooms.has(roomName)) this.rooms.delete(roomName);
    return nickname ?? null;
  }

  addMessage(roomName, { type = 'user', nickname = null, text }) {
    const room = this.rooms.get(roomName);
    if (!room) return null;
    const message = { id: randomUUID(), type, nickname, text, at: this.now() };
    room.history.push(message);
    if (room.history.length > this.historyLimit) {
      room.history.splice(0, room.history.length - this.historyLimit);
    }
    return message;
  }
}

/**
 * 짧은 시간에 너무 많이 보내는 걸 막는 간단한 제한기.
 */
export class RateLimiter {
  constructor({ max = 5, windowMs = 3000, now = Date.now } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  allow(key) {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  forget(key) {
    this.hits.delete(key);
  }
}
