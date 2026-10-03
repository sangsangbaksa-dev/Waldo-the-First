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

  async upload(path, buffer, contentType) {
    this.files.set(path, { buffer, contentType });
  }

  async signedUrl(path) {
    if (!this.files.has(path)) throw new ChatError(404, '파일을 찾을 수 없어.');
    return `${this.publicConfig.url}/storage/v1/object/sign/chat-attachments/${path}?token=t`;
  }

  async download(path) {
    if (!this.files.has(path)) throw new ChatError(404, '파일을 찾을 수 없어.');
    return this.files.get(path).buffer;
  }

  async remove(paths) {
    for (const path of paths) this.files.delete(path);
  }
}
