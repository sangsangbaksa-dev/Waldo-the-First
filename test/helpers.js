import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createDb, pgliteAdapter } from '../src/db.js';
import { ChatError } from '../src/service.js';

/** 메모리 안에서 도는 진짜 Postgres에 같은 스키마를 올린다. */
export async function testDb() {
  const db = createDb(pgliteAdapter(new PGlite()));
  await db.migrate();
  return db;
}

/** Supabase Auth와 Storage 흉내. 실제 SupabaseGateway와 같은 메서드를 가진다. */
export class FakeSupabase {
  publicConfig = { url: 'https://test.supabase.co', anonKey: 'anon-key' };
  bucket = 'chat-attachments';
  uploadTokens = new Map(); // token → path
  accounts = new Map(); // email → { id, email, password, name }
  tokens = new Map(); // access token → account
  files = new Map(); // path → { buffer, contentType }

  async createUser({ email, password, name }) {
    if (this.accounts.has(email)) throw new ChatError(409, '이미 가입된 이메일이야. 로그인해 줘.');
    const account = { id: randomUUID(), email, password, name };
    this.accounts.set(email, account);
    return { id: account.id, email };
  }

  /** 브라우저가 Supabase에 로그인해서 토큰을 받는 것을 흉내 낸다. */
  signInWithPassword(email, password) {
    const account = this.accounts.get(email);
    if (!account || account.password !== password) return null;
    const token = randomUUID();
    this.tokens.set(token, account);
    return token;
  }

  async userFromAccessToken(token) {
    const account = this.tokens.get(token);
    return account ? { id: account.id, email: account.email, name: account.name } : null;
  }

  async verifyPassword(email, password) {
    const account = this.accounts.get(email);
    return account && account.password === password ? account.id : null;
  }

  async updatePassword(authId, password) {
    for (const account of this.accounts.values()) if (account.id === authId) account.password = password;
  }

  async createUploadUrl(path) {
    const token = randomUUID();
    this.uploadTokens.set(token, path);
    return { path, token };
  }

  /** 브라우저가 1회용 토큰으로 Storage에 올리는 것을 흉내 낸다. */
  browserUpload(path, token, buffer, contentType) {
    if (this.uploadTokens.get(token) !== path) throw new Error('bad token');
    this.uploadTokens.delete(token);
    this.files.set(path, { buffer, contentType });
  }

  async exists(path) {
    return this.files.has(path);
  }

  async signedUrl(path) {
    if (!this.files.has(path)) throw new ChatError(404, '파일을 찾을 수 없어.');
    return `${this.publicConfig.url}/storage/v1/object/sign/chat-attachments/${path}?token=t`;
  }

  async remove(paths) {
    for (const path of paths) this.files.delete(path);
  }
}

/** Supabase Realtime 흉내: 보낸 방송을 모아 두고, 기다릴 수 있게 한다. */
export class FakeRealtime {
  sent = []; // { topic, event, payload }
  waiters = [];

  async broadcast(messages) {
    for (const m of messages) {
      this.sent.push(m);
      for (const w of [...this.waiters]) {
        if (w.match(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m.payload);
        }
      }
    }
  }

  toUsers(userIds, event, payload) {
    return this.broadcast([...new Set(userIds)].map((id) => ({ topic: `user:${id}`, event, payload })));
  }

  toEveryone(event, payload) {
    return this.broadcast([{ topic: 'chat:everyone', event, payload }]);
  }

  /** 이미 왔거나 앞으로 올 방송 하나를 기다린다. */
  next(topic, event, where = () => true) {
    const match = (m) => m.topic === topic && m.event === event && where(m.payload);
    const found = this.sent.find(match);
    if (found) {
      this.sent.splice(this.sent.indexOf(found), 1);
      return Promise.resolve(found.payload);
    }
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }
}
