import { createClient } from '@supabase/supabase-js';
import { ChatError } from './service.js';

const SERVER_AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

/**
 * 서버가 Supabase에 하는 일을 모아 둔 곳.
 * - 계정 만들기: service_role 키로 관리자 API를 써서 이메일 인증 없이 바로 확정된 계정을 만든다.
 * - 로그인 확인: 브라우저가 Supabase에서 받은 access token이 진짜인지 확인한다.
 * - 파일: 브라우저가 1회용 토큰으로 비공개 Storage 버킷에 직접 올리고, 받을 때는 잠깐만 유효한 서명 URL을 쓴다.
 * service_role 키는 서버에만 있고 브라우저로는 절대 보내지 않는다.
 */
export class SupabaseGateway {
  constructor({ url, serviceRoleKey, anonKey, bucket = 'chat-attachments' }) {
    this.url = url.replace(/\/$/, '');
    this.anonKey = anonKey;
    this.bucket = bucket;
    this.admin = createClient(this.url, serviceRoleKey, { auth: SERVER_AUTH });
  }

  /** 브라우저에 알려 줘도 되는 값(공개 키)만. */
  get publicConfig() {
    return { url: this.url, anonKey: this.anonKey };
  }

  async createUser({ email, password, name }) {
    const { data, error } = await this.admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // 인증 메일 없이 바로 쓸 수 있는 계정
      user_metadata: { name },
    });
    if (error) {
      if (error.code === 'email_exists' || (error.status === 422 && /already/i.test(error.message))) {
        throw new ChatError(409, '이미 가입된 이메일이야. 로그인해 줘.');
      }
      if (error.code === 'weak_password') throw new ChatError(400, '비밀번호가 너무 약해. 더 길게 만들어 줘.');
      throw new ChatError(502, `계정을 만들지 못했어: ${error.message}`);
    }
    return { id: data.user.id, email: data.user.email };
  }

  async userFromAccessToken(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken) return null;
    const { data, error } = await this.admin.auth.getUser(accessToken);
    if (error || !data?.user) return null;
    return { id: data.user.id, email: data.user.email, name: data.user.user_metadata?.name ?? null };
  }

  /** 비밀번호가 맞으면 Supabase 사용자 ID를, 틀리면 null을 준다. */
  async verifyPassword(email, password) {
    const client = createClient(this.url, this.anonKey, { auth: SERVER_AUTH });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data?.user) return null;
    return data.user.id;
  }

  async updatePassword(authId, password) {
    const { error } = await this.admin.auth.admin.updateUserById(authId, { password });
    if (error) {
      if (error.code === 'weak_password') throw new ChatError(400, '비밀번호가 너무 약해. 더 길게 만들어 줘.');
      throw new ChatError(502, `비밀번호를 바꾸지 못했어: ${error.message}`);
    }
  }

  /** 첨부 파일용 비공개 버킷이 없으면 만든다. */
  async ensureBucket(fileSizeLimit) {
    const { data } = await this.admin.storage.getBucket(this.bucket);
    if (data) return;
    const { error } = await this.admin.storage.createBucket(this.bucket, { public: false, fileSizeLimit });
    if (error && !/already exists/i.test(error.message)) throw new Error(`Storage 버킷을 만들지 못했어: ${error.message}`);
  }

  /**
   * 브라우저가 Storage에 직접 올릴 수 있는 1회용 업로드 토큰.
   * (Vercel 함수는 요청 크기가 4.5MB로 제한돼서, 파일을 서버를 거쳐 올릴 수 없다.)
   */
  async createUploadUrl(path) {
    const { data, error } = await this.admin.storage.from(this.bucket).createSignedUploadUrl(path);
    if (error) throw new ChatError(502, `업로드를 준비하지 못했어: ${error.message}`);
    return { path: data.path, token: data.token };
  }

  async exists(path) {
    const { data, error } = await this.admin.storage.from(this.bucket).exists(path);
    return !error && data === true;
  }

  /** 파일을 볼 때 쓰는 짧은 서명 URL. 내려받기 이름은 브라우저가 붙인다(Storage는 한글 이름을 두 번 인코딩한다). */
  async signedUrl(path, { expiresIn = 60 } = {}) {
    const { data, error } = await this.admin.storage.from(this.bucket).createSignedUrl(path, expiresIn);
    if (error) throw new ChatError(404, '파일을 찾을 수 없어.');
    return data.signedUrl;
  }

  async remove(paths) {
    if (!paths.length) return;
    const { error } = await this.admin.storage.from(this.bucket).remove(paths);
    if (error) console.error('Storage 파일 삭제 실패:', error.message);
  }
}
