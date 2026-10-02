/* global io */
const $ = (id) => document.getElementById(id);

const els = {
  login: $('login'),
  loginForm: $('login-form'),
  nickname: $('nickname'),
  roomSelect: $('room-select'),
  newRoom: $('new-room'),
  loginError: $('login-error'),
  chat: $('chat'),
  me: $('me'),
  roomList: $('room-list'),
  roomForm: $('room-form'),
  roomInput: $('room-input'),
  userList: $('user-list'),
  userCount: $('user-count'),
  logout: $('logout'),
  menu: $('menu'),
  roomTitle: $('room-title'),
  status: $('status'),
  messages: $('messages'),
  typing: $('typing'),
  messageForm: $('message-form'),
  messageInput: $('message-input'),
  chatError: $('chat-error'),
};

const state = {
  nickname: null,
  room: null,
  rooms: [],
  typers: new Set(),
};

const socket = io();

function readSavedNickname() {
  try {
    return localStorage.getItem('waldo-chat:nickname') ?? '';
  } catch {
    return '';
  }
}

function saveNickname(value) {
  try {
    localStorage.setItem('waldo-chat:nickname', value);
  } catch {
    // 저장이 막혀 있어도 채팅은 된다.
  }
}

els.nickname.value = readSavedNickname();

function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function renderRooms() {
  const current = els.roomSelect.value;
  els.roomSelect.replaceChildren(
    ...state.rooms.map(({ name, users }) => new Option(`${name} (${users}명)`, name)),
  );
  if (state.rooms.some((r) => r.name === current)) els.roomSelect.value = current;

  els.roomList.replaceChildren(
    ...state.rooms.map(({ name, users }) => {
      const li = document.createElement('li');
      li.dataset.room = name;
      li.classList.toggle('active', name === state.room);
      const label = document.createElement('span');
      label.textContent = `# ${name}`;
      const count = document.createElement('span');
      count.className = 'muted';
      count.textContent = users;
      li.append(label, count);
      return li;
    }),
  );
}

function renderUsers(users) {
  els.userCount.textContent = `(${users.length})`;
  els.userList.replaceChildren(
    ...users.map((name) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = name === state.nickname ? `${name} (나)` : name;
      li.append(label);
      return li;
    }),
  );
}

function renderTyping() {
  const names = [...state.typers];
  if (names.length === 0) els.typing.textContent = '';
  else if (names.length <= 2) els.typing.textContent = `${names.join(', ')} 님이 입력하고 있어…`;
  else els.typing.textContent = `${names.length}명이 입력하고 있어…`;
}

function isNearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = els.messages;
  return scrollHeight - scrollTop - clientHeight < 80;
}

function appendMessage(message, { scroll = true } = {}) {
  const stick = isNearBottom();
  const li = document.createElement('li');
  li.className = 'msg';

  if (message.type === 'system') {
    li.classList.add('system');
    li.textContent = `${message.text} · ${timeLabel(message.at)}`;
  } else {
    if (message.nickname === state.nickname) li.classList.add('mine');
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${message.nickname} · ${timeLabel(message.at)}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = message.text;
    li.append(meta, bubble);
  }

  els.messages.append(li);
  if (scroll && (stick || message.nickname === state.nickname)) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

function enterRoom(result) {
  state.nickname = result.nickname;
  state.room = result.room;
  state.typers.clear();
  renderTyping();
  saveNickname(result.nickname);

  els.login.hidden = true;
  els.chat.hidden = false;
  els.chat.classList.remove('menu-open');
  els.me.textContent = `접속: ${result.nickname}`;
  els.roomTitle.textContent = `# ${result.room}`;
  document.title = `# ${result.room} · Waldo Chat`;
  els.chatError.textContent = '';

  els.messages.replaceChildren();
  for (const message of result.history) appendMessage(message, { scroll: false });
  els.messages.scrollTop = els.messages.scrollHeight;

  renderUsers(result.users);
  renderRooms();
  els.messageInput.focus();
}

function join(nickname, room, errorEl) {
  errorEl.textContent = '';
  socket.emit('join', { nickname, room }, (result) => {
    if (result.error) {
      errorEl.textContent = result.error;
      return;
    }
    enterRoom(result);
  });
}

// 입장
els.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const room = els.newRoom.value.trim() || els.roomSelect.value;
  join(els.nickname.value, room, els.loginError);
});

// 방 옮기기
els.roomList.addEventListener('click', (event) => {
  const li = event.target.closest('li[data-room]');
  if (!li || li.dataset.room === state.room) return;
  join(state.nickname, li.dataset.room, els.chatError);
});

els.roomForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const room = els.roomInput.value.trim();
  if (!room) return;
  els.roomInput.value = '';
  join(state.nickname, room, els.chatError);
});

els.logout.addEventListener('click', () => {
  socket.emit('leave', () => {
    state.room = null;
    els.chat.hidden = true;
    els.login.hidden = false;
    document.title = 'Waldo Chat';
    els.nickname.focus();
  });
});

els.menu.addEventListener('click', () => els.chat.classList.toggle('menu-open'));

// 메시지 보내기
let typingTimer = null;
let typingSent = false;

function stopTyping() {
  clearTimeout(typingTimer);
  if (typingSent) socket.emit('typing', false);
  typingSent = false;
}

function autoGrow() {
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = `${els.messageInput.scrollHeight}px`;
}

els.messageInput.addEventListener('input', () => {
  autoGrow();
  if (!typingSent) {
    socket.emit('typing', true);
    typingSent = true;
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 2000);
});

els.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.messageForm.requestSubmit();
  }
});

els.messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.messageInput.value;
  if (!text.trim()) return;
  stopTyping();
  socket.emit('message', { text }, (result) => {
    if (result.error) {
      els.chatError.textContent = result.error;
      return;
    }
    els.chatError.textContent = '';
    els.messageInput.value = '';
    autoGrow();
  });
});

// 서버에서 오는 것
socket.on('rooms', (rooms) => {
  state.rooms = rooms;
  renderRooms();
});

socket.on('users', renderUsers);

socket.on('message', (message) => {
  if (message.nickname) state.typers.delete(message.nickname);
  renderTyping();
  appendMessage(message);
});

socket.on('typing', ({ nickname, typing }) => {
  if (typing) state.typers.add(nickname);
  else state.typers.delete(nickname);
  renderTyping();
});

socket.on('connect', () => {
  els.status.classList.add('online');
  els.status.title = '연결됨';
  // 다시 연결되면 있던 방으로 자동으로 돌아간다.
  if (state.room) join(state.nickname, state.room, els.chatError);
});

socket.on('disconnect', () => {
  els.status.classList.remove('online');
  els.status.title = '연결 끊김';
});
