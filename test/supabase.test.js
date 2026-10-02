import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SupabaseGateway } from '../src/supabase.js';

// Supabase Auth(GoTrue)와 Storage의 REST 응답을 흉내 내는 서버.
// supabase-js가 실제로 어떤 요청을 보내는지 확인한다.
const requests = [];
let server;
let gateway;
const USER = { id: '6f1c3a0e-0000-4000-8000-000000000001', email: 'w@gmail.com', user_metadata: { name: '김월도' }, aud: 'authenticated' };

before(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const entry = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(entry);
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/auth/v1/admin/users' && req.method === 'POST') {
      const { email } = JSON.parse(body);
      if (email === 'taken@gmail.com') return json(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
      return json(200, { ...USER, email });
    }
    if (pathname === '/auth/v1/user') {
      return req.headers.authorization === 'Bearer good-token' ? json(200, USER) : json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
    }
    if (pathname === '/auth/v1/token') {
      const { password } = JSON.parse(body);
      if (password !== 'password123') return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return json(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, expires_at: 9999999999, token_type: 'bearer', user: USER });
    }
    if (pathname.startsWith('/auth/v1/admin/users/')) return json(200, USER);
    if (pathname === '/storage/v1/bucket/chat-attachments') return json(404, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
    if (pathname === '/storage/v1/bucket') return json(200, { name: 'chat-attachments' });
    if (pathname.startsWith('/storage/v1/object/sign/')) {
      return json(200, { signedURL: `${pathname.replace('/storage/v1', '')}?token=signed` });
    }
    if (pathname.startsWith('/storage/v1/object/')) return json(200, { Key: pathname, Id: 'x' });
    json(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, r));
  gateway = new SupabaseGateway({
    url: `http://localhost:${server.address().port}`,
    serviceRoleKey: 'service-role-secret',
    anonKey: 'anon-public',
  });
});

after(() => server.close());

const last = (pred) => [...requests].reverse().find(pred);

test('가입은 관리자 API로, 이메일 인증을 건너뛰게 만든다', async () => {
  const user = await gateway.createUser({ email: 'w@gmail.com', password: 'password123', name: '김월도' });
  assert.equal(user.id, USER.id);
  const req = last((r) => r.url === '/auth/v1/admin/users');
  assert.deepEqual(JSON.parse(req.body), {
    email: 'w@gmail.com',
    password: 'password123',
    email_confirm: true,
    user_metadata: { name: '김월도' },
  });
  assert.equal(req.headers.authorization, 'Bearer service-role-secret');

  await assert.rejects(gateway.createUser({ email: 'taken@gmail.com', password: 'password123', name: 'x' }), (e) => e.status === 409);
});

test('브라우저가 받은 토큰을 확인한다', async () => {
  assert.deepEqual(await gateway.userFromAccessToken('good-token'), { id: USER.id, email: USER.email, name: '김월도' });
  assert.equal(await gateway.userFromAccessToken('bad-token'), null);
  assert.equal(await gateway.userFromAccessToken(''), null);
});

test('비밀번호 확인은 공개 키로, 비밀번호 변경은 관리자 키로 한다', async () => {
  assert.equal(await gateway.verifyPassword('w@gmail.com', 'password123'), USER.id);
  assert.equal(last((r) => r.url.startsWith('/auth/v1/token')).headers.apikey, 'anon-public');
  assert.equal(await gateway.verifyPassword('w@gmail.com', 'nope'), null);
  await gateway.updatePassword(USER.id, 'newpassword1');
  const req = last((r) => r.url === `/auth/v1/admin/users/${USER.id}`);
  assert.equal(req.method, 'PUT');
  assert.deepEqual(JSON.parse(req.body), { password: 'newpassword1' });
});

test('Storage: 비공개 버킷 만들기, 올리기, 서명 URL, 지우기', async () => {
  await gateway.ensureBucket(1024);
  const created = last((r) => r.url === '/storage/v1/bucket' && r.method === 'POST');
  assert.equal(JSON.parse(created.body).public, false);

  await gateway.upload('u1/f1', Buffer.from('hi'), 'image/png');
  const up = last((r) => r.url === '/storage/v1/object/chat-attachments/u1/f1');
  assert.equal(up.method, 'POST');
  assert.equal(up.body, 'hi');
  assert.equal(up.headers['content-type'], 'image/png');

  const inline = await gateway.signedUrl('u1/f1');
  assert.match(inline, /\/storage\/v1\/object\/sign\/chat-attachments\/u1\/f1\?token=signed$/);
  const download = await gateway.signedUrl('u1/f1', { download: '메모.txt' });
  assert.match(download, /&download=/);

  await gateway.remove(['u1/f1']);
  const del = last((r) => r.method === 'DELETE');
  assert.equal(del.url, '/storage/v1/object/chat-attachments');
  assert.deepEqual(JSON.parse(del.body), { prefixes: ['u1/f1'] });
});
