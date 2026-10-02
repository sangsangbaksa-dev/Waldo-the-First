import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import {
  ChatStore,
  RateLimiter,
  validateMessage,
  validateNickname,
  validateRoomName,
} from './chat.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

export function createChatServer({ store = new ChatStore(), limiter = new RateLimiter() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(publicDir));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/rooms', (_req, res) => res.json(store.listRooms()));

  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 16 * 1024 });

  const broadcastRooms = () => io.emit('rooms', store.listRooms());
  const broadcastUsers = (roomName) => io.to(roomName).emit('users', store.usersIn(roomName));

  function system(roomName, text) {
    const message = store.addMessage(roomName, { type: 'system', text });
    if (message) io.to(roomName).emit('message', message);
  }

  function leaveCurrent(socket) {
    const { room, nickname } = socket.data;
    if (!room) return;
    socket.leave(room);
    store.leave(socket.id, room);
    socket.data.room = null;
    socket.to(room).emit('typing', { nickname, typing: false });
    system(room, `${nickname} 님이 나갔어.`);
    broadcastUsers(room);
  }

  io.on('connection', (socket) => {
    socket.emit('rooms', store.listRooms());

    socket.on('join', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const nickname = validateNickname(payload?.nickname);
      if (nickname.error) return reply({ error: nickname.error });
      const roomName = validateRoomName(payload?.room);
      if (roomName.error) return reply({ error: roomName.error });

      if (socket.data.room === roomName.value && socket.data.nickname === nickname.value) {
        const room = store.getRoom(roomName.value);
        return reply({ room: room.name, nickname: nickname.value, history: room.history, users: store.usersIn(room.name) });
      }

      if (store.isTaken(roomName.value, nickname.value, socket.id)) {
        return reply({ error: '이 방에 같은 닉네임이 이미 있어.' });
      }

      leaveCurrent(socket);
      const joined = store.join(socket.id, nickname.value, roomName.value);

      socket.data.nickname = nickname.value;
      socket.data.room = joined.room.name;
      socket.join(joined.room.name);

      reply({
        room: joined.room.name,
        nickname: nickname.value,
        history: joined.room.history,
        users: store.usersIn(joined.room.name),
      });
      system(joined.room.name, `${nickname.value} 님이 들어왔어.`);
      broadcastUsers(joined.room.name);
      broadcastRooms();
    });

    socket.on('message', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { room, nickname } = socket.data;
      if (!room) return reply({ error: '먼저 방에 들어가 줘.' });
      const text = validateMessage(payload?.text);
      if (text.error) return reply({ error: text.error });
      if (!limiter.allow(socket.id)) return reply({ error: '너무 빨리 보내고 있어. 잠깐만 쉬었다가 보내 줘.' });

      const message = store.addMessage(room, { nickname, text: text.value });
      io.to(room).emit('message', message);
      socket.to(room).emit('typing', { nickname, typing: false });
      reply({ ok: true, id: message.id });
    });

    socket.on('typing', (typing) => {
      const { room, nickname } = socket.data;
      if (!room) return;
      socket.to(room).emit('typing', { nickname, typing: Boolean(typing) });
    });

    socket.on('leave', (ack) => {
      leaveCurrent(socket);
      broadcastRooms();
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('disconnect', () => {
      leaveCurrent(socket);
      limiter.forget(socket.id);
      broadcastRooms();
    });
  });

  return { app, httpServer, io, store };
}
