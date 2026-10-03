import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { mountAuth, parseCookies, PASSWORD_MIN, SESSION_COOKIE, validatePassword } from './auth.js';
import { ChatError } from './service.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
export const MAX_UPLOAD = 25 * 1024 * 1024;
// 브라우저 안에서 바로 열어도 안전한 형식만 그 형식 그대로 저장하고 보여 준다.
export const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm)|audio\/[\w.+-]+|application\/pdf|text\/plain)$/;

// Supabase(로그인, 실시간, 파일)로 가는 연결만 허용한다. vercel.json에도 같은 값이 있다.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: blob: https://*.supabase.co",
  "media-src 'self' blob: https://*.supabase.co",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 채팅 API. 서버는 상태를 들고 있지 않아서 Vercel 같은 서버리스에서도 그대로 돈다.
 * 실시간 전달은 realtime(Supabase Realtime)에 맡긴다.
 */
export function createChatApp({ service, supabase, realtime, config, signupLimiter }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    });
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  // 다른 사이트가 몰래 요청을 보내지 못하게, 바꾸는 요청에는 직접 넣은 헤더를 요구한다.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.get('x-requested-with') !== 'chat') return res.status(403).json({ error: '잘못된 요청이야.' });
    next();
  });

  // 브라우저가 Supabase에 직접 로그인하고 실시간 채널을 구독할 때 쓰는 공개 값
  app.get('/api/config', (_req, res) => {
    res.json({ supabase: supabase.publicConfig, bucket: supabase.bucket, passwordMin: PASSWORD_MIN, maxUpload: MAX_UPLOAD });
  });

  mountAuth(app, { service, supabase, config, signupLimiter });

  const sessionToken = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const auth = async (req, res, next) => {
    const user = await service.userForSession(sessionToken(req));
    if (!user) return res.status(401).json({ error: '로그인이 필요해.' });
    req.user = user;
    next();
  };

  app.get('/api/session', async (req, res) => {
    res.json({ user: await service.userForSession(sessionToken(req)) });
  });

  // 실시간 전달이 잠깐 실패해도 요청 자체는 성공시킨다. 화면은 다시 연결될 때 새로 받아 온다.
  const send = async (promise) => {
    try {
      await promise;
    } catch (error) {
      console.error(error.message);
    }
  };
  const toUsers = (userIds, event, data) => send(realtime.toUsers(userIds, event, data));
  const toConversation = async (conversationId, event, data) => toUsers(await service.memberIds(conversationId), event, data);
  const conversationsChanged = (userIds) => toUsers(userIds, 'conversations:changed', {});
  const removeFiles = (paths) => supabase.remove(paths).catch((error) => console.error(error));

  // ───────────── API ─────────────

  const api = express.Router();
  api.use(auth);

  api.get('/me', (req, res) => res.json(req.user));

  api.patch('/me', async (req, res) => {
    const user = await service.updateProfile(req.user.id, req.body ?? {});
    // 이름이 바뀌면 나와 대화하는 사람들의 목록도 새로 그려야 한다.
    const conversations = await service.listConversations(user.id);
    await conversationsChanged([user.id, ...conversations.flatMap((c) => c.members.map((m) => m.id))]);
    res.json(user);
  });

  api.post('/me/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    validatePassword(newPassword);
    const authId = await service.authIdOf(req.user.id);
    const verified = await supabase.verifyPassword(req.user.email, String(currentPassword ?? ''));
    if (!authId || verified !== authId) throw new ChatError(400, '지금 비밀번호가 맞지 않아.');
    await supabase.updatePassword(authId, newPassword);
    await service.deleteOtherSessions(req.user.id, sessionToken(req));
    res.json({ ok: true });
  });

  api.patch('/me/status', async (req, res) => {
    const user = await service.setStatus(req.user.id, req.body ?? {});
    await send(realtime.toEveryone('status', { userId: user.id, status: user.status, statusText: user.statusText }));
    res.json(user);
  });

  api.get('/users', async (req, res) => {
    res.json(await service.searchUsers(req.user.id, String(req.query.q ?? '')));
  });

  api.get('/conversations', async (req, res) => res.json(await service.listConversations(req.user.id)));

  api.post('/conversations/direct', async (req, res) => {
    const { conversation, created } = await service.openDirect(req.user.id, req.body?.emails ?? []);
    if (created) await conversationsChanged(conversation.members.map((m) => m.id));
    res.status(created ? 201 : 200).json(conversation);
  });

  api.post('/spaces', async (req, res) => {
    const conversation = await service.createSpace(req.user.id, req.body ?? {});
    await conversationsChanged(conversation.members.map((m) => m.id));
    res.status(201).json(conversation);
  });

  api.get('/spaces/browse', async (req, res) => {
    res.json(await service.listPublicSpaces(req.user.id, String(req.query.q ?? '')));
  });

  api.post('/spaces/:id/join', async (req, res) => {
    const conversation = await service.joinSpace(req.user.id, req.params.id);
    await conversationsChanged(await service.memberIds(req.params.id));
    res.json(conversation);
  });

  api.get('/conversations/:id', async (req, res) => res.json(await service.getConversation(req.user.id, req.params.id)));

  api.patch('/conversations/:id', async (req, res) => {
    const conversation = await service.updateSpace(req.user.id, req.params.id, req.body ?? {});
    await conversationsChanged(await service.memberIds(req.params.id));
    res.json(conversation);
  });

  api.delete('/conversations/:id', async (req, res) => {
    const { memberIds, files } = await service.deleteSpace(req.user.id, req.params.id);
    removeFiles(files);
    await toUsers(memberIds, 'conversation:removed', { id: req.params.id });
    res.json({ ok: true });
  });

  api.patch('/conversations/:id/preferences', async (req, res) => {
    const conversation = await service.setPreferences(req.user.id, req.params.id, req.body ?? {});
    await conversationsChanged([req.user.id]);
    res.json(conversation);
  });

  api.post('/conversations/:id/read', async (req, res) => {
    const at = await service.markRead(req.user.id, req.params.id);
    await toConversation(req.params.id, 'read', { conversationId: req.params.id, userId: req.user.id, at });
    res.json({ at });
  });

  api.post('/conversations/:id/typing', async (req, res) => {
    if (!(await service.membership(req.user.id, req.params.id))) throw new ChatError(404, '대화를 찾을 수 없어.');
    const others = (await service.memberIds(req.params.id)).filter((id) => id !== req.user.id);
    await toUsers(others, 'typing', {
      conversationId: req.params.id,
      threadId: typeof req.body?.threadId === 'string' ? req.body.threadId : null,
      userId: req.user.id,
      name: req.user.name,
      typing: Boolean(req.body?.typing),
    });
    res.status(204).end();
  });

  api.post('/conversations/:id/members', async (req, res) => {
    const added = await service.addMembers(req.user.id, req.params.id, req.body?.emails ?? []);
    await conversationsChanged(await service.memberIds(req.params.id));
    res.json({ added });
  });

  api.delete('/conversations/:id/members/:userId', async (req, res) => {
    const before = await service.memberIds(req.params.id);
    await service.removeMember(req.user.id, req.params.id, req.params.userId);
    await toUsers([req.params.userId], 'conversation:removed', { id: req.params.id });
    await conversationsChanged(before);
    res.json({ ok: true });
  });

  api.patch('/conversations/:id/members/:userId', async (req, res) => {
    await service.setRole(req.user.id, req.params.id, req.params.userId, req.body?.role);
    await conversationsChanged(await service.memberIds(req.params.id));
    res.json(await service.getConversation(req.user.id, req.params.id));
  });

  api.get('/conversations/:id/messages', async (req, res) => {
    const before = req.query.before ? Number(req.query.before) : undefined;
    const threadId = req.query.thread ? String(req.query.thread) : undefined;
    res.json(await service.listMessages(req.user.id, req.params.id, { before, threadId }));
  });

  const broadcastThreadRoot = async (userId, message) => {
    if (!message.threadId) return;
    await toConversation(message.conversationId, 'message:update', {
      message: await service.getMessage(userId, message.threadId),
    });
  };

  api.post('/conversations/:id/messages', async (req, res) => {
    const ids = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds : [];
    // 브라우저가 Storage에 올리기를 끝냈는지 확인한다.
    for (const path of await service.pendingAttachmentPaths(req.user.id, ids)) {
      if (!(await supabase.exists(path))) throw new ChatError(400, '파일이 아직 다 올라가지 않았어. 잠깐 뒤에 다시 보내 줘.');
    }
    const { message, mentioned } = await service.sendMessage(req.user.id, req.params.id, req.body ?? {});
    await toConversation(req.params.id, 'message:new', { message, mentioned });
    await broadcastThreadRoot(req.user.id, message);
    res.status(201).json(message);
  });

  api.patch('/messages/:id', async (req, res) => {
    const message = await service.editMessage(req.user.id, req.params.id, req.body?.body);
    await toConversation(message.conversationId, 'message:update', { message });
    res.json(message);
  });

  api.delete('/messages/:id', async (req, res) => {
    const { message, files } = await service.deleteMessage(req.user.id, req.params.id);
    removeFiles(files);
    await toConversation(message.conversationId, 'message:update', { message });
    await broadcastThreadRoot(req.user.id, message);
    res.json(message);
  });

  api.post('/messages/:id/reactions', async (req, res) => {
    const message = await service.toggleReaction(req.user.id, req.params.id, req.body?.emoji);
    await toConversation(message.conversationId, 'message:update', { message });
    res.json(message);
  });

  api.post('/messages/:id/star', async (req, res) => res.json(await service.toggleStar(req.user.id, req.params.id)));

  api.get('/starred', async (req, res) => res.json(await service.listStarred(req.user.id)));
  api.get('/mentions', async (req, res) => res.json(await service.listMentions(req.user.id)));
  api.get('/search', async (req, res) => {
    const conversationId = req.query.conversation ? String(req.query.conversation) : undefined;
    res.json(await service.search(req.user.id, String(req.query.q ?? ''), { conversationId }));
  });

  // 파일 올리기 1단계: 첨부 자리를 만들고, 브라우저가 Storage에 직접 올릴 1회용 토큰을 준다.
  api.post('/uploads', async (req, res) => {
    let filename = typeof req.body?.filename === 'string' ? req.body.filename : 'file';
    filename = filename.replace(/[\\/\0\r\n]/g, '_').slice(0, 200) || 'file';
    const size = Number(req.body?.size);
    if (!Number.isInteger(size) || size <= 0) throw new ChatError(400, '빈 파일은 올릴 수 없어.');
    if (size > MAX_UPLOAD) throw new ChatError(413, '파일이 너무 커. 25MB까지 올릴 수 있어.');
    const mime = String(req.body?.mime || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100);
    const id = randomUUID();
    const { path, token } = await supabase.createUploadUrl(`${req.user.id}/${id}`);
    const attachment = await service.createAttachment(req.user.id, { id, filename, mime, size, path });
    res.status(201).json({
      attachment,
      // 위험할 수 있는 형식은 Storage에도 그냥 바이너리로 저장한다.
      upload: { bucket: supabase.bucket, path, token, contentType: INLINE_TYPES.test(mime) ? mime : 'application/octet-stream' },
    });
  });

  // 내려받기용: 권한 확인 뒤 서명 URL과 원래 파일 이름을 준다. 브라우저가 이 이름으로 저장한다.
  api.get('/files/:id', async (req, res) => {
    const file = await service.attachmentFor(req.user.id, req.params.id);
    res.json({ url: await supabase.signedUrl(file.path), filename: file.filename, mime: file.mime });
  });

  app.use('/api', api);

  // <img src> 같은 곳에서 쓰는 주소: 권한 확인 뒤 1분짜리 서명 URL로 보낸다.
  app.get('/files/:id', auth, async (req, res) => {
    const file = await service.attachmentFor(req.user.id, req.params.id);
    res.set('Cache-Control', 'private, max-age=30');
    res.redirect(302, await supabase.signedUrl(file.path));
  });

  app.use(express.static(publicDir));

  app.use((error, _req, res, _next) => {
    if (error instanceof ChatError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '요청이 너무 커.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: '요청 형식이 잘못됐어.' });
    console.error(error);
    res.status(500).json({ error: '서버에서 문제가 생겼어.' });
  });

  return app;
}
