import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { mountAuth, parseCookies, PASSWORD_MIN, SESSION_COOKIE, validatePassword } from './auth.js';
import { ChatError } from './service.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
export const MAX_UPLOAD = 25 * 1024 * 1024;
// 브라우저 안에서 바로 열어도 안전한 형식만 inline으로 보여 준다.
const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm)|audio\/[\w.+-]+|application\/pdf|text\/plain)$/;

export function createChatServer({ service, supabase, config, signupLimiter }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  const supabaseOrigin = new URL(supabase.publicConfig.url).origin;
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': [
        "default-src 'self'",
        `img-src 'self' data: ${supabaseOrigin}`,
        `media-src 'self' ${supabaseOrigin}`,
        "style-src 'self'",
        "script-src 'self'",
        `connect-src 'self' ws: wss: ${supabaseOrigin}`,
        "frame-ancestors 'none'",
      ].join('; '),
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

  // 로그인 화면이 Supabase에 직접 로그인할 때 쓰는 공개 값
  app.get('/api/config', (_req, res) => res.json({ supabase: supabase.publicConfig, passwordMin: PASSWORD_MIN }));

  mountAuth(app, { service, supabase, config, signupLimiter });

  const sessionToken = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const auth = async (req, res, next) => {
    const user = await service.userForSession(sessionToken(req));
    if (!user) return res.status(401).json({ error: '로그인이 필요해.' });
    req.user = user;
    next();
  };

  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 64 * 1024 });

  // ───────────── 접속 상태 ─────────────

  const connections = new Map(); // userId → 열린 소켓 수
  const presenceOf = (user) => {
    if (!user) return 'offline';
    if (user.status === 'dnd') return 'dnd';
    if (!connections.get(user.id)) return 'offline';
    return user.status === 'away' ? 'away' : 'online';
  };
  const withPresence = (user) => user && { ...user, presence: presenceOf(user) };
  const broadcastPresence = async (userId) => {
    const user = await service.getUser(userId);
    if (!user) return;
    io.emit('presence', { userId, presence: presenceOf(user), statusText: user.statusText, lastSeen: user.lastSeen });
  };

  app.get('/api/session', async (req, res) => {
    const user = await service.userForSession(sessionToken(req));
    res.json({ user: withPresence(user) });
  });

  const toUsers = (userIds, event, data) => {
    for (const id of new Set(userIds)) io.to(`user:${id}`).emit(event, data);
  };
  const toConversation = async (conversationId, event, data) => toUsers(await service.memberIds(conversationId), event, data);
  const conversationsChanged = (userIds) => toUsers(userIds, 'conversations:changed', {});
  const removeFiles = (paths) => supabase.remove(paths).catch((error) => console.error(error));

  // ───────────── API ─────────────

  const api = express.Router();
  api.use(auth);

  api.get('/me', (req, res) => res.json(withPresence(req.user)));

  api.patch('/me', async (req, res) => {
    const user = await service.updateProfile(req.user.id, req.body ?? {});
    // 이름이 바뀌면 나와 대화하는 사람들의 목록도 새로 그려야 한다.
    const conversations = await service.listConversations(user.id);
    conversationsChanged([user.id, ...conversations.flatMap((c) => c.members.map((m) => m.id))]);
    res.json(withPresence(user));
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
    await broadcastPresence(user.id);
    res.json(withPresence(user));
  });

  api.get('/users', async (req, res) => {
    res.json((await service.searchUsers(req.user.id, String(req.query.q ?? ''))).map(withPresence));
  });

  api.get('/presence', async (_req, res) => {
    const result = {};
    for (const userId of connections.keys()) result[userId] = presenceOf(await service.getUser(userId));
    res.json(result);
  });

  api.get('/conversations', async (req, res) => res.json(await service.listConversations(req.user.id)));

  api.post('/conversations/direct', async (req, res) => {
    const { conversation, created } = await service.openDirect(req.user.id, req.body?.emails ?? []);
    if (created) conversationsChanged(conversation.members.map((m) => m.id));
    res.status(created ? 201 : 200).json(conversation);
  });

  api.post('/spaces', async (req, res) => {
    const conversation = await service.createSpace(req.user.id, req.body ?? {});
    conversationsChanged(conversation.members.map((m) => m.id));
    res.status(201).json(conversation);
  });

  api.get('/spaces/browse', async (req, res) => {
    res.json(await service.listPublicSpaces(req.user.id, String(req.query.q ?? '')));
  });

  api.post('/spaces/:id/join', async (req, res) => {
    const conversation = await service.joinSpace(req.user.id, req.params.id);
    conversationsChanged(await service.memberIds(req.params.id));
    res.json(conversation);
  });

  api.get('/conversations/:id', async (req, res) => res.json(await service.getConversation(req.user.id, req.params.id)));

  api.patch('/conversations/:id', async (req, res) => {
    const conversation = await service.updateSpace(req.user.id, req.params.id, req.body ?? {});
    conversationsChanged(await service.memberIds(req.params.id));
    res.json(conversation);
  });

  api.delete('/conversations/:id', async (req, res) => {
    const { memberIds, files } = await service.deleteSpace(req.user.id, req.params.id);
    removeFiles(files);
    toUsers(memberIds, 'conversation:removed', { id: req.params.id });
    res.json({ ok: true });
  });

  api.patch('/conversations/:id/preferences', async (req, res) => {
    res.json(await service.setPreferences(req.user.id, req.params.id, req.body ?? {}));
    conversationsChanged([req.user.id]);
  });

  api.post('/conversations/:id/read', async (req, res) => {
    const at = await service.markRead(req.user.id, req.params.id);
    await toConversation(req.params.id, 'read', { conversationId: req.params.id, userId: req.user.id, at });
    res.json({ at });
  });

  api.post('/conversations/:id/members', async (req, res) => {
    const added = await service.addMembers(req.user.id, req.params.id, req.body?.emails ?? []);
    conversationsChanged(await service.memberIds(req.params.id));
    res.json({ added });
  });

  api.delete('/conversations/:id/members/:userId', async (req, res) => {
    const before = await service.memberIds(req.params.id);
    await service.removeMember(req.user.id, req.params.id, req.params.userId);
    toUsers([req.params.userId], 'conversation:removed', { id: req.params.id });
    conversationsChanged(before);
    res.json({ ok: true });
  });

  api.patch('/conversations/:id/members/:userId', async (req, res) => {
    await service.setRole(req.user.id, req.params.id, req.params.userId, req.body?.role);
    conversationsChanged(await service.memberIds(req.params.id));
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

  api.post('/uploads', express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new ChatError(400, '빈 파일은 올릴 수 없어.');
    let filename = 'file';
    try {
      filename = decodeURIComponent(req.get('x-filename') ?? 'file');
    } catch {
      // 이름이 깨졌으면 기본 이름을 쓴다.
    }
    filename = filename.replace(/[\\/\0\r\n]/g, '_').slice(0, 200) || 'file';
    const mime = (req.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const id = randomUUID();
    const path = `${req.user.id}/${id}`;
    // 위험할 수 있는 형식은 Storage에도 그냥 바이너리로 저장한다.
    await supabase.upload(path, req.body, INLINE_TYPES.test(mime) ? mime : 'application/octet-stream');
    res.status(201).json(await service.createAttachment(req.user.id, { id, filename, mime, size: req.body.length, path }));
  });

  app.use('/api', api);

  // 브라우저에서 여는 파일은 권한 확인 뒤 1분짜리 서명 URL로 보내고,
  // 내려받는 파일은 올바른 파일 이름을 붙여 서버가 직접 보낸다.
  app.get('/files/:id', auth, async (req, res) => {
    const file = await service.attachmentFor(req.user.id, req.params.id);
    if (INLINE_TYPES.test(file.mime) && req.query.download === undefined) {
      res.set('Cache-Control', 'private, max-age=30');
      return res.redirect(302, await supabase.signedUrl(file.path));
    }
    const content = await supabase.download(file.path);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Cache-Control': 'private, no-store',
    });
    res.send(content);
  });

  app.use(express.static(publicDir));

  app.use((error, _req, res, _next) => {
    if (error instanceof ChatError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '파일이 너무 커. 25MB까지 올릴 수 있어.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: '요청 형식이 잘못됐어.' });
    console.error(error);
    res.status(500).json({ error: '서버에서 문제가 생겼어.' });
  });

  // ───────────── 소켓 ─────────────

  io.use(async (socket, next) => {
    try {
      const user = await service.userForSession(parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE]);
      if (!user) return next(new Error('unauthorized'));
      socket.data.userId = user.id;
      next();
    } catch (error) {
      next(error);
    }
  });

  const logError = (error) => console.error('소켓 처리 실패:', error);

  io.on('connection', (socket) => {
    const { userId } = socket.data;
    socket.join(`user:${userId}`);
    connections.set(userId, (connections.get(userId) ?? 0) + 1);
    service.touch(userId).then(() => broadcastPresence(userId)).catch(logError);

    socket.on('typing', async (payload) => {
      try {
        const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : null;
        if (!conversationId || !(await service.membership(userId, conversationId))) return;
        const others = (await service.memberIds(conversationId)).filter((id) => id !== userId);
        const user = await service.getUser(userId);
        toUsers(others, 'typing', {
          conversationId,
          threadId: typeof payload.threadId === 'string' ? payload.threadId : null,
          userId,
          name: user.name,
          typing: Boolean(payload.typing),
        });
      } catch (error) {
        logError(error);
      }
    });

    socket.on('disconnect', () => {
      const left = (connections.get(userId) ?? 1) - 1;
      if (left > 0) connections.set(userId, left);
      else connections.delete(userId);
      service.touch(userId).then(() => broadcastPresence(userId)).catch(logError);
    });
  });

  return { app, httpServer, io };
}
