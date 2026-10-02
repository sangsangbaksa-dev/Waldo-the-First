import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { mountAuth, parseCookies, SESSION_COOKIE } from './auth.js';
import { ChatError } from './service.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const MAX_UPLOAD = 25 * 1024 * 1024;
// 브라우저 안에서 바로 열어도 안전한 형식만 inline으로 보여 준다.
const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm)|audio\/\w+|application\/pdf|text\/plain)$/;

export function createChatServer({ service, config, uploadDir, fetchImpl }) {
  mkdirSync(uploadDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https://*.googleusercontent.com; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
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

  mountAuth(app, { service, config, fetchImpl });

  app.get('/api/config', (_req, res) => res.json({ google: Boolean(config.google), devLogin: config.devLogin }));

  const currentUser = (req) => service.userForSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  // 로그인 여부만 확인한다(로그아웃 상태여도 200).
  app.get('/api/session', (req, res) => {
    const user = currentUser(req);
    res.json({ user: user ? withPresence(user) : null });
  });

  const auth = (req, res, next) => {
    const user = currentUser(req);
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
  const broadcastPresence = (userId) => {
    const user = service.getUser(userId);
    io.emit('presence', { userId, presence: presenceOf(user), statusText: user.statusText, lastSeen: user.lastSeen });
  };

  const toUsers = (userIds, event, data) => {
    for (const id of new Set(userIds)) io.to(`user:${id}`).emit(event, data);
  };
  const toConversation = (conversationId, event, data) => toUsers(service.memberIds(conversationId), event, data);
  const conversationsChanged = (userIds) => toUsers(userIds, 'conversations:changed', {});
  const removeFiles = (paths) => {
    for (const path of paths) rmSync(path, { force: true });
  };

  // ───────────── API ─────────────

  const api = express.Router();
  api.use(auth);

  api.get('/me', (req, res) => res.json(withPresence(req.user)));

  api.patch('/me/status', (req, res) => {
    const user = service.setStatus(req.user.id, req.body ?? {});
    broadcastPresence(user.id);
    res.json(withPresence(user));
  });

  api.get('/users', (req, res) => {
    res.json(service.searchUsers(req.user.id, String(req.query.q ?? '')).map(withPresence));
  });

  api.get('/presence', (_req, res) => {
    const result = {};
    for (const userId of connections.keys()) result[userId] = presenceOf(service.getUser(userId));
    res.json(result);
  });

  api.get('/conversations', (req, res) => res.json(service.listConversations(req.user.id)));

  api.post('/conversations/direct', (req, res) => {
    const { conversation, created } = service.openDirect(req.user.id, req.body?.emails ?? []);
    if (created) conversationsChanged(conversation.members.map((m) => m.id));
    res.status(created ? 201 : 200).json(conversation);
  });

  api.post('/spaces', (req, res) => {
    const conversation = service.createSpace(req.user.id, req.body ?? {});
    conversationsChanged(conversation.members.map((m) => m.id));
    res.status(201).json(conversation);
  });

  api.get('/spaces/browse', (req, res) => res.json(service.listPublicSpaces(req.user.id, String(req.query.q ?? ''))));

  api.post('/spaces/:id/join', (req, res) => {
    const conversation = service.joinSpace(req.user.id, req.params.id);
    conversationsChanged(service.memberIds(req.params.id));
    res.json(conversation);
  });

  api.get('/conversations/:id', (req, res) => res.json(service.getConversation(req.user.id, req.params.id)));

  api.patch('/conversations/:id', (req, res) => {
    const conversation = service.updateSpace(req.user.id, req.params.id, req.body ?? {});
    conversationsChanged(service.memberIds(req.params.id));
    res.json(conversation);
  });

  api.delete('/conversations/:id', (req, res) => {
    const { memberIds, files } = service.deleteSpace(req.user.id, req.params.id);
    removeFiles(files);
    toUsers(memberIds, 'conversation:removed', { id: req.params.id });
    res.json({ ok: true });
  });

  api.patch('/conversations/:id/preferences', (req, res) => {
    res.json(service.setPreferences(req.user.id, req.params.id, req.body ?? {}));
    conversationsChanged([req.user.id]);
  });

  api.post('/conversations/:id/read', (req, res) => {
    const at = service.markRead(req.user.id, req.params.id);
    toConversation(req.params.id, 'read', { conversationId: req.params.id, userId: req.user.id, at });
    res.json({ at });
  });

  api.post('/conversations/:id/members', (req, res) => {
    const added = service.addMembers(req.user.id, req.params.id, req.body?.emails ?? []);
    conversationsChanged(service.memberIds(req.params.id));
    res.json({ added });
  });

  api.delete('/conversations/:id/members/:userId', (req, res) => {
    const before = service.memberIds(req.params.id);
    service.removeMember(req.user.id, req.params.id, req.params.userId);
    toUsers([req.params.userId], 'conversation:removed', { id: req.params.id });
    conversationsChanged(before);
    res.json({ ok: true });
  });

  api.patch('/conversations/:id/members/:userId', (req, res) => {
    service.setRole(req.user.id, req.params.id, req.params.userId, req.body?.role);
    conversationsChanged(service.memberIds(req.params.id));
    res.json(service.getConversation(req.user.id, req.params.id));
  });

  api.get('/conversations/:id/messages', (req, res) => {
    const before = req.query.before ? Number(req.query.before) : undefined;
    const threadId = req.query.thread ? String(req.query.thread) : undefined;
    res.json(service.listMessages(req.user.id, req.params.id, { before, threadId }));
  });

  api.post('/conversations/:id/messages', (req, res) => {
    const { message, mentioned } = service.sendMessage(req.user.id, req.params.id, req.body ?? {});
    toConversation(req.params.id, 'message:new', { message, mentioned });
    if (message.threadId) {
      toConversation(req.params.id, 'message:update', { message: service.getMessage(req.user.id, message.threadId) });
    }
    res.status(201).json(message);
  });

  const broadcastMessage = (userId, message) => {
    toConversation(message.conversationId, 'message:update', { message });
    if (message.threadId) {
      toConversation(message.conversationId, 'message:update', { message: service.getMessage(userId, message.threadId) });
    }
  };

  api.patch('/messages/:id', (req, res) => {
    const message = service.editMessage(req.user.id, req.params.id, req.body?.body);
    broadcastMessage(req.user.id, message);
    res.json(message);
  });

  api.delete('/messages/:id', (req, res) => {
    const { message, files } = service.deleteMessage(req.user.id, req.params.id);
    removeFiles(files);
    broadcastMessage(req.user.id, message);
    res.json(message);
  });

  api.post('/messages/:id/reactions', (req, res) => {
    const message = service.toggleReaction(req.user.id, req.params.id, req.body?.emoji);
    toConversation(message.conversationId, 'message:update', { message });
    res.json(message);
  });

  api.post('/messages/:id/star', (req, res) => res.json(service.toggleStar(req.user.id, req.params.id)));

  api.get('/starred', (req, res) => res.json(service.listStarred(req.user.id)));
  api.get('/mentions', (req, res) => res.json(service.listMentions(req.user.id)));
  api.get('/search', (req, res) => {
    const conversationId = req.query.conversation ? String(req.query.conversation) : undefined;
    res.json(service.search(req.user.id, String(req.query.q ?? ''), { conversationId }));
  });

  api.post('/uploads', express.raw({ type: () => true, limit: MAX_UPLOAD }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new ChatError(400, '빈 파일은 올릴 수 없어.');
    let filename = 'file';
    try {
      filename = decodeURIComponent(req.get('x-filename') ?? 'file');
    } catch {
      // 이름이 깨졌으면 기본 이름을 쓴다.
    }
    filename = filename.replace(/[\\/\0\r\n]/g, '_').slice(0, 200) || 'file';
    const mime = (req.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const path = join(uploadDir, randomUUID());
    writeFileSync(path, req.body);
    res.status(201).json(service.createAttachment(req.user.id, { filename, mime, size: req.body.length, path }));
  });

  app.use('/api', api);

  app.get('/files/:id', auth, (req, res) => {
    const file = service.attachmentFor(req.user.id, req.params.id);
    const inline = INLINE_TYPES.test(file.mime) && req.query.download === undefined;
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    // res.attachment()는 확장자로 형식을 다시 정하므로 쓰지 않는다.
    res.set({
      'Content-Type': inline ? file.mime : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    });
    res.sendFile(file.path);
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

  io.use((socket, next) => {
    const user = service.userForSession(parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE]);
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    const { userId } = socket.data;
    socket.join(`user:${userId}`);
    connections.set(userId, (connections.get(userId) ?? 0) + 1);
    service.touch(userId);
    broadcastPresence(userId);

    socket.on('typing', (payload) => {
      const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : null;
      if (!conversationId || !service.membership(userId, conversationId)) return;
      const others = service.memberIds(conversationId).filter((id) => id !== userId);
      toUsers(others, 'typing', {
        conversationId,
        threadId: typeof payload.threadId === 'string' ? payload.threadId : null,
        userId,
        name: service.getUser(userId).name,
        typing: Boolean(payload.typing),
      });
    });

    socket.on('disconnect', () => {
      const left = (connections.get(userId) ?? 1) - 1;
      if (left > 0) connections.set(userId, left);
      else connections.delete(userId);
      service.touch(userId);
      broadcastPresence(userId);
    });
  });

  return { app, httpServer, io };
}
