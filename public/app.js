/* global supabase */
import { fromEditable, parseBody, renderBody, toEditable } from './format.js';

// ───────────── 도우미 ─────────────

const $ = (selector, root = document) => root.querySelector(selector);

/** 안전하게 DOM을 만든다. 문자열 자식은 항상 텍스트로 들어간다. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'x-requested-with': 'chat',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && path.startsWith('/api/') && path !== '/api/me/password') {
    location.reload();
    throw new Error('로그인이 필요해.');
  }
  if (!res.ok) throw new Error(data?.error ?? '요청에 실패했어.');
  return data;
}

function toast(message, { error = false } = {}) {
  const el = h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

const run = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (error) {
    toast(error.message, { error: true });
    return undefined;
  }
};

const AVATAR_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#12838e', '#c5221f', '#b06000'];
function colorFor(id = '') {
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

function avatar(user, size = 32, { presence = true } = {}) {
  const wrap = h('span', { class: 'avatar', dataset: { size } });
  wrap.style.width = wrap.style.height = `${size}px`;
  if (user?.avatar) {
    wrap.append(h('img', { src: user.avatar, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' }));
  } else {
    const initial = h('span', { class: 'initial' }, (user?.name ?? '?').slice(0, 1).toUpperCase());
    initial.style.background = colorFor(user?.id);
    initial.style.fontSize = `${Math.round(size * 0.45)}px`;
    wrap.append(initial);
  }
  if (presence && user?.id) {
    wrap.append(h('span', { class: `presence ${presenceOf(user.id)}`, dataset: { presenceUser: user.id } }));
  }
  return wrap;
}

function spaceAvatar(conversation, size = 32) {
  const el = h('span', { class: 'space-avatar' }, conversation.emoji || conversation.name.slice(0, 1));
  el.style.width = el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * (conversation.emoji ? 0.55 : 0.45))}px`;
  if (!conversation.emoji) el.style.background = colorFor(conversation.id);
  else el.classList.add('emoji');
  return el;
}

function groupAvatar(conversation, size = 32) {
  const others = conversation.members.filter((m) => m.id !== state.me.id);
  if (conversation.kind === 'space') return spaceAvatar(conversation, size);
  if (others.length <= 1) return avatar(others[0] ?? state.me, size);
  const el = h('span', { class: 'group-avatar' }, avatar(others[0], size * 0.68, { presence: false }), avatar(others[1], size * 0.68, { presence: false }));
  el.style.width = el.style.height = `${size}px`;
  return el;
}

const dayFormat = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
const timeFormat = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
const fullFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return '오늘';
  if (d.toDateString() === yesterday.toDateString()) return '어제';
  return dayFormat.format(d);
}

function shortTime(ms) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? timeFormat.format(d) : dayFormat.format(d);
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const STATUS_LABEL = { online: '활동 중', away: '자리 비움', dnd: '방해 금지', offline: '오프라인' };
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😎', '🤔', '😮', '😢', '😭', '😡', '🥳', '😴',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '👀', '🤝', '✌️', '👋', '❤️', '🧡', '💛', '💚', '💙', '💜',
  '🔥', '✨', '🎉', '💯', '✅', '❌', '⭐', '☕', '🍕', '🎂', '📌', '📎', '💡', '📚', '⏰', '🚀',
];
const SPACE_EMOJIS = ['💬', '📚', '🎮', '🎵', '⚽', '🍔', '💼', '🧪', '🎨', '🌱', '🏫', '🚀'];

// ───────────── 상태 ─────────────

const state = {
  me: null,
  config: null,
  conversations: new Map(),
  view: { type: 'home' },
  messages: new Map(), // conversationId → { list, hasMore, loading }
  thread: null, // { conversationId, rootId, list }
  typing: new Map(), // conversationId → Map(userId → { name, threadId, timer })
  online: new Set(), // 지금 접속해 있는 사람 (Supabase Realtime presence)
  statuses: new Map(), // userId → 'auto' | 'away' | 'dnd'
  realtimeUp: false,
  collapsed: new Set(),
  notify: localStorage.getItem('chat:notify') !== 'off',
};

function presenceOf(userId) {
  const mine = userId === state.me?.id;
  const status = mine ? state.me.status : (state.statuses.get(userId) ?? 'auto');
  const online = mine ? state.realtimeUp : state.online.has(userId);
  if (status === 'dnd') return 'dnd';
  if (!online) return 'offline';
  return status === 'away' ? 'away' : 'online';
}

function rememberStatuses(users) {
  for (const user of users) if (user?.id && user.status) state.statuses.set(user.id, user.status);
}

// 브라우저용 Supabase: 로그인 세션을 들고 있고, 실시간 채널을 구독한다.
let sb;

const activeConversation = () =>
  state.view.type === 'conversation' ? state.conversations.get(state.view.id) : null;

// ───────────── 시작 ─────────────

async function boot() {
  state.config = await api('GET', '/api/config');
  sb = supabase.createClient(state.config.supabase.url, state.config.supabase.anonKey, {
    auth: { storageKey: 'waldo-chat-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const { user: me } = await api('GET', '/api/session');
  if (!me) return showLogin();

  // 실시간 채널은 Supabase 로그인 세션으로 연다. 세션이 없거나 다른 계정이면 다시 로그인한다.
  const { data } = await sb.auth.getSession();
  if (!data.session || data.session.user.email?.toLowerCase() !== me.email) {
    await api('POST', '/auth/logout').catch(() => {});
    return showLogin('실시간 연결을 위해 한 번만 다시 로그인해 줘.');
  }

  state.me = me;
  $('#app').hidden = false;
  try {
    state.collapsed = new Set(JSON.parse(localStorage.getItem('chat:collapsed') ?? '[]'));
  } catch {
    state.collapsed = new Set();
  }
  renderTopbar();
  await refreshConversations();
  connectRealtime();
  bindShell();
  route();
  window.addEventListener('hashchange', route);
}

function showLogin(message = '') {
  $('#login').hidden = false;
  const error = $('#login-error');
  error.textContent = message;
  const tabs = document.querySelectorAll('.login-tabs [data-tab]');
  const show = (tab) => {
    for (const t of tabs) t.classList.toggle('on', t.dataset.tab === tab);
    $('#signin-form').hidden = tab !== 'signin';
    $('#signup-form').hidden = tab !== 'signup';
    error.textContent = '';
    $(`#${tab}-form input`).focus();
  };
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.tab));

  const busy = (form, on) => {
    form.querySelector('[type=submit]').disabled = on;
  };

  // 로그인: 브라우저가 Supabase에 직접 로그인하고(세션은 실시간 연결에도 쓴다),
  // 받은 토큰으로 이 사이트의 세션 쿠키를 연다.
  const signIn = async (email, password) => {
    const { data, error: failure } = await sb.auth.signInWithPassword({ email: String(email).trim(), password });
    if (failure) {
      if (failure.status === 429) throw new Error('로그인 시도가 너무 많아. 잠시 뒤에 다시 해 줘.');
      if (failure.code === 'invalid_credentials' || failure.status === 400) throw new Error('이메일 또는 비밀번호가 맞지 않아.');
      throw new Error('로그인 서버에 연결하지 못했어.');
    }
    await api('POST', '/auth/session', { accessToken: data.session.access_token });
  };

  $('#signin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    error.textContent = '';
    busy(event.target, true);
    try {
      await signIn(form.get('email'), form.get('password'));
      location.reload();
    } catch (err) {
      error.textContent = err.message === 'Failed to fetch' ? '로그인 서버에 연결하지 못했어.' : err.message;
      busy(event.target, false);
    }
  });

  $('#signup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    error.textContent = '';
    if (form.get('password') !== form.get('confirm')) {
      error.textContent = '비밀번호 확인이 달라.';
      return;
    }
    busy(event.target, true);
    try {
      await api('POST', '/auth/signup', { name: form.get('name'), email: form.get('email'), password: form.get('password') });
      await signIn(form.get('email'), form.get('password'));
      location.reload();
    } catch (err) {
      error.textContent = err.message;
      busy(event.target, false);
    }
  });
}

// ───────────── 라우팅 ─────────────

function route() {
  const [type, id, extra] = location.hash.replace(/^#\/?/, '').split('/');
  closeNav();
  if (type === 'chat' && id) {
    if (!state.conversations.has(id)) {
      location.hash = '#/home';
      return;
    }
    const changed = state.view.type !== 'conversation' || state.view.id !== id;
    state.view = { type: 'conversation', id };
    if (changed) closeThread();
    renderNav();
    openConversation(id).then(() => {
      if (extra) openThread(id, extra);
    });
    return;
  }
  closeThread();
  if (type === 'mentions' || type === 'starred') state.view = { type };
  else if (type === 'search') state.view = { type: 'search', q: decodeURIComponent(id ?? '') };
  else state.view = { type: 'home' };
  renderNav();
  renderMain();
}

const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

// ───────────── 상단 바 ─────────────

function renderTopbar() {
  const me = state.me;
  const status = $('#status-btn');
  const presence = presenceOf(me.id);
  status.replaceChildren(h('span', { class: `presence-dot ${presence}` }), STATUS_LABEL[presence] ?? '활동 중');
  $('#avatar-btn').replaceChildren(avatar(me, 32, { presence: false }));
}

function bindShell() {
  $('#nav-toggle').addEventListener('click', () => {
    if (matchMedia('(max-width: 900px)').matches) $('#app').classList.toggle('nav-open');
    else $('#app').classList.toggle('nav-collapsed');
  });
  $('#scrim').addEventListener('click', closeNav);

  $('#search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const q = $('#search-input').value.trim();
    if (q) go(`#/search/${encodeURIComponent(q)}`);
  });

  $('#status-btn').addEventListener('click', (event) => openStatusMenu(event.currentTarget));
  $('#avatar-btn').addEventListener('click', (event) => openAccountMenu(event.currentTarget));
  $('#new-chat-btn').addEventListener('click', (event) => openNewMenu(event.currentTarget));
  $('#browse-btn').addEventListener('click', () => openBrowseSpaces());

  for (const item of document.querySelectorAll('.nav-item[data-view]')) {
    item.addEventListener('click', () => go(`#/${item.dataset.view}`));
  }
  for (const head of document.querySelectorAll('.nav-section-head')) {
    head.addEventListener('click', () => {
      const key = head.dataset.section;
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      localStorage.setItem('chat:collapsed', JSON.stringify([...state.collapsed]));
      renderNav();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closePopover();
      if (!$('#thread').hidden && !$('#dialog').open) closeThread();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
      event.preventDefault();
      $('#search-input').focus();
    }
  });

  window.addEventListener('focus', markActiveRead);
  document.addEventListener('visibilitychange', markActiveRead);
}

function closeNav() {
  $('#app').classList.remove('nav-open');
}

function openStatusMenu(anchor) {
  const choose = (status) =>
    run(async () => {
      state.me = await api('PATCH', '/api/me/status', { status });
      renderTopbar();
      updatePresenceDots(state.me.id);
      closePopover();
    });
  popover(anchor, [
    menuItem('🟢 자동', choose('auto'), { checked: state.me.status === 'auto' }),
    menuItem('⛔ 방해 금지', choose('dnd'), { checked: state.me.status === 'dnd' }),
    menuItem('🟡 자리 비움으로 표시', choose('away'), { checked: state.me.status === 'away' }),
    h('hr'),
    menuItem('✏️ 상태 메시지 설정', () => {
      closePopover();
      openStatusText();
    }),
  ]);
}

function openStatusText() {
  const input = h('input', { name: 'text', maxlength: 80, value: state.me.statusText ?? '', placeholder: '예: 회의 중, 점심 먹는 중' });
  openDialog('상태 메시지', [h('label', {}, '다른 사람에게 보이는 상태', input)], {
    submitLabel: '저장',
    onSubmit: async () => {
      state.me = await api('PATCH', '/api/me/status', { statusText: input.value });
      renderTopbar();
    },
  });
}

function openAccountMenu(anchor) {
  const me = state.me;
  popover(anchor, [
    h('div', { class: 'account-card' }, avatar(me, 56, { presence: false }), h('strong', {}, me.name), h('span', { class: 'muted' }, me.email),
      me.statusText ? h('span', { class: 'muted' }, `“${me.statusText}”`) : null),
    h('hr'),
    menuItem(state.notify ? '🔔 데스크톱 알림 끄기' : '🔕 데스크톱 알림 켜기', async () => {
      closePopover();
      if (!state.notify) {
        if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
        state.notify = true;
      } else state.notify = false;
      localStorage.setItem('chat:notify', state.notify ? 'on' : 'off');
      toast(state.notify ? '알림을 켰어.' : '알림을 껐어.');
    }),
    menuItem('👤 이름 바꾸기', () => { closePopover(); openProfile(); }),
    menuItem('🔑 비밀번호 바꾸기', () => { closePopover(); openPassword(); }),
    menuItem('↪ 로그아웃', run(async () => {
      await api('POST', '/auth/logout');
      await sb.auth.signOut().catch(() => {});
      location.href = '/';
    })),
  ], { align: 'right' });
}

function openProfile() {
  const input = h('input', { maxlength: 40, value: state.me.name, required: true, autocomplete: 'name' });
  openDialog('이름 바꾸기', [h('label', {}, '이름(실명)', input)], {
    submitLabel: '저장',
    onSubmit: async () => {
      state.me = { ...state.me, ...(await api('PATCH', '/api/me', { name: input.value })) };
      renderTopbar();
      toast('이름을 바꿨어.');
    },
  });
}

function openPassword() {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true, placeholder: '8자 이상' });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  openDialog('비밀번호 바꾸기', [
    h('label', {}, '지금 비밀번호', current),
    h('label', {}, '새 비밀번호', next),
    h('label', {}, '새 비밀번호 확인', confirm),
    h('p', { class: 'muted' }, '바꾸면 다른 기기에서는 로그아웃돼.'),
  ], {
    submitLabel: '바꾸기',
    onSubmit: async () => {
      if (next.value !== confirm.value) throw new Error('새 비밀번호 확인이 달라.');
      await api('POST', '/api/me/password', { currentPassword: current.value, newPassword: next.value });
      toast('비밀번호를 바꿨어.');
    },
  });
}

// ───────────── 팝오버 / 메뉴 / 대화상자 ─────────────

function closePopover() {
  $('#popover-root').replaceChildren();
}

function popover(anchor, content, { align = 'left' } = {}) {
  closePopover();
  const panel = h('div', { class: 'popover', role: 'menu' }, content);
  const backdrop = h('div', { class: 'popover-backdrop', onclick: closePopover });
  $('#popover-root').append(backdrop, panel);
  const rect = anchor.getBoundingClientRect();
  const { innerWidth: w, innerHeight: vh } = window;
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  let left = align === 'right' ? rect.right - pw : rect.left;
  left = Math.max(8, Math.min(left, w - pw - 8));
  let top = rect.bottom + 6;
  if (top + ph > vh - 8) top = Math.max(8, rect.top - ph - 6);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.querySelector('button, input')?.focus();
  return panel;
}

function menuItem(label, onClick, { danger = false, checked = false } = {}) {
  return h('button', { class: `menu-item${danger ? ' danger' : ''}${checked ? ' checked' : ''}`, role: 'menuitem', onclick: onClick }, label);
}

function emojiPicker(anchor, onPick) {
  popover(anchor, h('div', { class: 'emoji-grid' }, EMOJIS.map((e) =>
    h('button', { class: 'emoji', title: e, onclick: () => { closePopover(); onPick(e); } }, e))));
}

/**
 * 공용 대화상자. onSubmit이 에러를 던지면 대화상자 안에 보여 주고 닫지 않는다.
 */
function openDialog(title, body, { submitLabel, onSubmit, danger = false, wide = false } = {}) {
  const dialog = $('#dialog');
  const error = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { method: 'dialog', class: 'dialog-form' },
    h('header', {}, h('h2', {}, title), h('button', { type: 'button', class: 'icon-btn', 'aria-label': '닫기', onclick: () => dialog.close() }, '✕')),
    h('div', { class: 'dialog-body' }, body),
    error,
    h('footer', {},
      h('button', { type: 'button', class: 'btn text', onclick: () => dialog.close() }, onSubmit ? '취소' : '닫기'),
      onSubmit ? h('button', { type: 'submit', class: `btn${danger ? ' danger' : ''}` }, submitLabel ?? '확인') : null));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!onSubmit) return dialog.close();
    error.textContent = '';
    const button = form.querySelector('footer [type=submit]');
    button.disabled = true;
    try {
      const keepOpen = await onSubmit();
      if (!keepOpen) dialog.close();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  dialog.classList.toggle('wide', wide);
  dialog.replaceChildren(form);
  dialog.showModal();
  form.querySelector('.dialog-body input, .dialog-body textarea, .dialog-body select')?.focus();
  return dialog;
}

const confirmDialog = (title, message, label, action) =>
  openDialog(title, h('p', {}, message), { submitLabel: label, danger: true, onSubmit: action });

// ───────────── 사람 고르기 ─────────────

/** 이름이나 이메일로 사람을 찾고, 없으면 이메일을 그대로 넣을 수 있는 입력칸. */
function peoplePicker({ placeholder = '이름 또는 이메일', exclude = [] } = {}) {
  const selected = new Map(); // email → user
  const chips = h('div', { class: 'chips' });
  const input = h('input', { placeholder, autocomplete: 'off' });
  const results = h('ul', { class: 'people-results' });
  const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  const renderChips = () => {
    chips.replaceChildren(...[...selected.values()].map((u) =>
      h('span', { class: 'chip' }, u.name ?? u.email,
        h('button', { type: 'button', 'aria-label': '빼기', onclick: () => { selected.delete(u.email); renderChips(); } }, '✕'))));
  };
  const add = (user) => {
    selected.set(user.email, user);
    input.value = '';
    results.replaceChildren();
    renderChips();
    input.focus();
  };

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run(async () => {
      const q = input.value.trim();
      if (!q) return results.replaceChildren();
      const users = (await api('GET', `/api/users?q=${encodeURIComponent(q)}`))
        .filter((u) => !exclude.includes(u.id) && !selected.has(u.email));
      const items = users.map((u) =>
        h('li', {}, h('button', { type: 'button', onclick: () => add(u) }, avatar(u, 28),
          h('span', { class: 'who' }, h('strong', {}, u.name), h('span', { class: 'muted' }, u.email)))));
      if (isEmail(q) && !users.some((u) => u.email === q.toLowerCase())) {
        items.push(h('li', {}, h('button', { type: 'button', onclick: () => add({ email: q.toLowerCase(), name: q }) },
          h('span', { class: 'nav-icon' }, '✉️'), h('span', { class: 'who' }, h('strong', {}, q), h('span', { class: 'muted' }, '이메일로 초대')))));
      }
      results.replaceChildren(...items);
    }), 150);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const q = input.value.trim();
      const first = results.querySelector('button');
      if (first) first.click();
      else if (isEmail(q)) add({ email: q.toLowerCase(), name: q });
    }
    if (event.key === 'Backspace' && !input.value && selected.size) {
      selected.delete([...selected.keys()].pop());
      renderChips();
    }
  });

  return {
    element: h('div', { class: 'people-picker' }, h('div', { class: 'people-input' }, chips, input), results),
    emails: () => {
      const q = input.value.trim();
      const list = [...selected.keys()];
      if (isEmail(q) && !list.includes(q.toLowerCase())) list.push(q.toLowerCase());
      return list;
    },
  };
}

// ───────────── 새 채팅 / 스페이스 ─────────────

function openNewMenu(anchor) {
  popover(anchor, [
    menuItem('👤 1:1 채팅 또는 그룹 채팅 시작', () => { closePopover(); openNewChat(); }),
    menuItem('👥 스페이스 만들기', () => { closePopover(); openCreateSpace(); }),
    menuItem('🔎 스페이스 찾아보기', () => { closePopover(); openBrowseSpaces(); }),
  ]);
}

function openNewChat() {
  const picker = peoplePicker({ exclude: [state.me.id] });
  openDialog('새 채팅', [
    h('p', { class: 'muted' }, '한 명을 고르면 1:1 채팅, 여러 명을 고르면 그룹 채팅이 돼. 아직 가입 안 한 사람은 이메일 주소로 초대할 수 있어.'),
    picker.element,
  ], {
    submitLabel: '채팅 시작',
    onSubmit: async () => {
      const emails = picker.emails();
      if (!emails.length) throw new Error('대화할 사람을 골라 줘.');
      const conversation = await api('POST', '/api/conversations/direct', { emails });
      await refreshConversations();
      go(`#/chat/${conversation.id}`);
    },
  });
}

function emojiChoice(current) {
  let value = current ?? null;
  const buttons = SPACE_EMOJIS.map((e) => h('button', { type: 'button', class: `emoji${e === value ? ' selected' : ''}`, onclick: (event) => {
    value = value === e ? null : e;
    for (const b of event.currentTarget.parentElement.children) b.classList.toggle('selected', b.textContent === value);
  } }, e));
  return { element: h('div', { class: 'emoji-row' }, buttons), value: () => value };
}

function openCreateSpace() {
  const name = h('input', { maxlength: 128, required: true, placeholder: '예: 2학년 3반, 동아리 기획' });
  const description = h('textarea', { maxlength: 150, rows: 2, placeholder: '이 스페이스에서 하는 일' });
  const emoji = emojiChoice(null);
  const visibility = h('select', {}, h('option', { value: 'private' }, '비공개 — 초대한 사람만'), h('option', { value: 'public' }, '공개 — 누구나 찾아서 참여'));
  const picker = peoplePicker({ exclude: [state.me.id] });
  openDialog('스페이스 만들기', [
    h('label', {}, '스페이스 이름', name),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '아이콘'), emoji.element),
    h('label', {}, '설명 (선택)', description),
    h('label', {}, '누가 찾을 수 있나요?', visibility),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '사람 추가 (선택)'), picker.element),
  ], {
    submitLabel: '만들기',
    onSubmit: async () => {
      const space = await api('POST', '/api/spaces', {
        name: name.value,
        description: description.value,
        emoji: emoji.value(),
        visibility: visibility.value,
        memberEmails: picker.emails(),
      });
      await refreshConversations();
      go(`#/chat/${space.id}`);
    },
  });
}

function openBrowseSpaces() {
  const search = h('input', { type: 'search', placeholder: '스페이스 이름으로 찾기' });
  const list = h('ul', { class: 'browse-list' });
  const load = run(async () => {
    const spaces = await api('GET', `/api/spaces/browse?q=${encodeURIComponent(search.value)}`);
    if (!spaces.length) return list.replaceChildren(h('li', { class: 'empty' }, '참여할 수 있는 공개 스페이스가 없어.'));
    list.replaceChildren(...spaces.map((s) => h('li', {},
      spaceAvatar(s, 40),
      h('div', { class: 'who' }, h('strong', {}, s.name), h('span', { class: 'muted' }, `멤버 ${s.memberCount}명${s.description ? ` · ${s.description}` : ''}`)),
      h('button', { type: 'button', class: 'btn', onclick: run(async () => {
        await api('POST', `/api/spaces/${s.id}/join`);
        $('#dialog').close();
        await refreshConversations();
        go(`#/chat/${s.id}`);
      }) }, '참여'))));
  });
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
  openDialog('스페이스 찾아보기', [search, list], { wide: true });
  load();
}

// ───────────── 대화 목록 ─────────────

async function refreshConversations() {
  const list = await api('GET', '/api/conversations');
  state.conversations = new Map(list.map((c) => [c.id, c]));
  for (const c of list) rememberStatuses(c.members);
  renderNav();
  updateTitle();
  if (state.view.type === 'conversation') {
    const conversation = activeConversation();
    if (!conversation) go('#/home');
    else renderConversationHeader(conversation);
  }
  if (state.view.type === 'home') renderMain();
}

let refreshTimer;
const refreshSoon = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(run(refreshConversations), 150);
};

function preview(conversation) {
  const last = conversation.lastMessage;
  if (!last) return conversation.kind === 'space' ? conversation.description || '새 스페이스' : '대화를 시작해 봐';
  if (last.deleted) return '삭제된 메시지';
  const body = parseBody(last.body).map(plain).join('').replace(/\s+/g, ' ').trim() || '📎 파일';
  if (last.kind === 'system') return body;
  const author = last.author === state.me.name ? '나' : last.author;
  return conversation.kind === 'dm' && author !== '나' ? body : `${author}: ${body}`;
}

/** 목록 미리보기용: 서식 기호 없이 글자만. */
function plain(token) {
  if (token.type === 'mention') return token.id === 'all' ? '@all' : '@…';
  if (token.type === 'link') return token.href;
  if (token.children) return token.children.map(plain).join('');
  return token.text;
}

function navEntry(conversation) {
  const active = state.view.type === 'conversation' && state.view.id === conversation.id;
  const unread = conversation.unread > 0;
  return h('li', {},
    h('a', {
      href: `#/chat/${conversation.id}`,
      class: `nav-chat${active ? ' active' : ''}${unread ? ' unread' : ''}${conversation.muted ? ' muted-chat' : ''}`,
      title: conversation.name,
    },
    groupAvatar(conversation, 28),
    h('span', { class: 'nav-chat-text' },
      h('span', { class: 'nav-chat-name' }, conversation.name),
      h('span', { class: 'nav-chat-preview' }, typingText(conversation.id) || preview(conversation))),
    h('span', { class: 'nav-chat-meta' },
      conversation.pinned ? h('span', { title: '고정됨' }, '📌') : null,
      conversation.muted ? h('span', { title: '알림 끔' }, '🔕') : null,
      conversation.mentionCount ? h('span', { class: 'badge mention' }, '@') : unread && !conversation.muted ? h('span', { class: 'badge' }, conversation.unread > 99 ? '99+' : conversation.unread) : null)));
}

function renderNav() {
  const all = [...state.conversations.values()].filter((c) => !c.hidden);
  const dms = all.filter((c) => c.kind !== 'space');
  const spaces = all.filter((c) => c.kind === 'space');

  for (const [key, el, items] of [['dms', '#dm-list', dms], ['spaces', '#space-list', spaces]]) {
    const collapsed = state.collapsed.has(key);
    $(`.nav-section-head[data-section="${key}"]`).classList.toggle('collapsed', collapsed);
    // 접혀 있어도 안 읽은 대화와 지금 보고 있는 대화는 보여 준다.
    const shown = collapsed ? items.filter((c) => c.unread || (state.view.type === 'conversation' && state.view.id === c.id)) : items;
    $(el).replaceChildren(...(shown.length || collapsed ? shown.map(navEntry) : [h('li', { class: 'nav-empty' }, key === 'dms' ? '아직 채팅이 없어' : '아직 스페이스가 없어')]));
  }

  for (const item of document.querySelectorAll('.nav-item[data-view]')) {
    item.classList.toggle('active', state.view.type === item.dataset.view);
  }
  const mentions = all.reduce((n, c) => n + c.mentionCount, 0);
  $('#mention-total').hidden = mentions === 0;
  $('#mention-total').textContent = mentions;
}

function updateTitle() {
  const unread = [...state.conversations.values()].filter((c) => (c.unread && !c.muted) || c.mentionCount).length;
  const base = activeConversation()?.name ?? 'Waldo Chat';
  document.title = unread ? `(${unread}) ${base}` : base;
}

// ───────────── 가운데 화면 ─────────────

function renderMain() {
  const main = $('#main');
  const { type } = state.view;
  if (type === 'home') return renderHome(main);
  if (type === 'mentions') return renderMessageCollection(main, '멘션', '나를 @멘션한 메시지가 여기에 모여.', () => api('GET', '/api/mentions'));
  if (type === 'starred') return renderMessageCollection(main, '별표표시됨', '메시지에 ☆를 누르면 여기에 모아 둘 수 있어.', () => api('GET', '/api/starred'));
  if (type === 'search') {
    $('#search-input').value = state.view.q;
    return renderMessageCollection(main, `“${state.view.q}” 검색 결과`, '찾는 메시지가 없어.', () => api('GET', `/api/search?q=${encodeURIComponent(state.view.q)}`));
  }
  return undefined;
}

function renderHome(main) {
  const items = [...state.conversations.values()].filter((c) => !c.hidden).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  const unreadOnly = main.dataset.filter === 'unread';
  const shown = unreadOnly ? items.filter((c) => c.unread || c.mentionCount) : items;
  main.replaceChildren(
    h('header', { class: 'view-head' }, h('h1', {}, '홈'),
      h('div', { class: 'segmented' },
        h('button', { class: unreadOnly ? '' : 'on', onclick: () => { main.dataset.filter = 'all'; renderHome(main); } }, '전체'),
        h('button', { class: unreadOnly ? 'on' : '', onclick: () => { main.dataset.filter = 'unread'; renderHome(main); } }, '읽지 않음'))),
    shown.length
      ? h('ul', { class: 'home-list' }, shown.map((c) => h('li', {}, h('a', { href: `#/chat/${c.id}`, class: c.unread ? 'unread' : '' },
        groupAvatar(c, 40),
        h('span', { class: 'who' }, h('strong', {}, c.name), h('span', { class: 'muted' }, preview(c))),
        h('span', { class: 'when muted' }, shortTime(c.lastMessageAt)),
        c.unread && !c.muted ? h('span', { class: 'badge' }, c.unread) : null))))
      : h('div', { class: 'empty-state' },
        h('img', { src: '/icon.svg', alt: '' }),
        h('h2', {}, unreadOnly ? '다 읽었어!' : '대화를 시작해 봐'),
        h('p', { class: 'muted' }, unreadOnly ? '읽지 않은 대화가 없어.' : '왼쪽 위 “새 채팅”으로 친구에게 말을 걸거나 스페이스를 만들어 봐.'),
        unreadOnly ? null : h('button', { class: 'btn', onclick: openNewChat }, '새 채팅')),
  );
}

async function renderMessageCollection(main, title, emptyText, load) {
  main.replaceChildren(h('header', { class: 'view-head' }, h('h1', {}, title)), h('div', { class: 'loading' }, '불러오는 중…'));
  const messages = await run(load)();
  if (!messages) return;
  const list = h('ul', { class: 'collection' });
  for (const message of messages) {
    const conversation = state.conversations.get(message.conversationId);
    if (!conversation) continue;
    const target = message.threadId ? `#/chat/${conversation.id}/${message.threadId}` : `#/chat/${conversation.id}`;
    list.append(h('li', {}, h('a', { href: target, class: 'collection-item', onclick: () => { state.highlight = message.id; } },
      h('div', { class: 'collection-where' }, groupAvatar(conversation, 20), conversation.name, message.threadId ? h('span', { class: 'muted' }, ' · 스레드') : null),
      h('div', { class: 'collection-msg' }, avatar(message.author, 32),
        h('div', {}, h('div', { class: 'msg-head' }, h('strong', {}, message.author?.name), h('span', { class: 'muted' }, fullFormat.format(message.createdAt))),
          h('div', { class: 'msg-body' }, renderBody(message.body, message.mentions, state.me.id)),
          message.attachments.length ? h('div', { class: 'muted' }, `📎 ${message.attachments.map((a) => a.filename).join(', ')}`) : null)))));
  }
  main.replaceChildren(h('header', { class: 'view-head' }, h('h1', {}, title)),
    list.children.length ? list : h('div', { class: 'empty-state' }, h('p', { class: 'muted' }, emptyText)));
}

// ───────────── 대화 화면 ─────────────

function memberSummary(conversation) {
  if (conversation.kind === 'dm') {
    const other = conversation.members.find((m) => m.id !== state.me.id);
    if (!other) return '';
    const presence = presenceOf(other.id);
    const parts = [STATUS_LABEL[presence]];
    if (other.statusText) parts.push(other.statusText);
    if (!other.registered) parts.push('아직 가입하지 않음 — 이 이메일로 가입하면 메시지를 볼 수 있어');
    return parts.join(' · ');
  }
  return `멤버 ${conversation.members.length}명${conversation.kind === 'space' && conversation.description ? ` · ${conversation.description}` : ''}`;
}

function renderConversationHeader(conversation) {
  const header = $('#main .conv-head');
  if (!header) return;
  header.replaceChildren(
    groupAvatar(conversation, 36),
    h('div', { class: 'conv-title' },
      h('h1', {}, conversation.name),
      h('span', { class: 'muted conv-sub', dataset: { sub: conversation.id } }, memberSummary(conversation))),
    h('div', { class: 'conv-actions' },
      conversation.kind !== 'dm' ? h('button', { class: 'icon-btn', title: '멤버', onclick: () => openMembers(conversation.id) }, '👥') : null,
      h('button', { class: 'icon-btn', title: '이 대화에서 검색', onclick: () => searchInConversation(conversation) }, '🔍'),
      h('button', { class: 'icon-btn', title: '더보기', onclick: (event) => openConversationMenu(event.currentTarget, conversation) }, '⋮')),
  );
}

function openConversationMenu(anchor, conversation) {
  const prefs = (patch, message) => run(async () => {
    closePopover();
    await api('PATCH', `/api/conversations/${conversation.id}/preferences`, patch);
    await refreshConversations();
    if (message) toast(message);
  });
  const items = [
    menuItem(conversation.pinned ? '📌 고정 해제' : '📌 고정', prefs({ pinned: !conversation.pinned })),
    menuItem(conversation.muted ? '🔔 알림 켜기' : '🔕 알림 끄기', prefs({ muted: !conversation.muted }, conversation.muted ? '알림을 켰어.' : '이 대화의 알림을 껐어. @멘션은 계속 알려 줄게.')),
    menuItem('🙈 대화 숨기기', run(async () => {
      await prefs({ hidden: true }, '대화를 숨겼어. 새 메시지가 오면 다시 보여.')();
      go('#/home');
    })),
  ];
  if (conversation.kind !== 'dm') {
    items.push(menuItem('👥 멤버 보기 및 추가', () => { closePopover(); openMembers(conversation.id); }));
  }
  if (conversation.kind === 'space' && conversation.role === 'manager') {
    items.push(menuItem('⚙️ 스페이스 설정', () => { closePopover(); openSpaceSettings(conversation); }));
  }
  if (conversation.kind !== 'dm') {
    items.push(h('hr'), menuItem(conversation.kind === 'space' ? '🚪 스페이스 나가기' : '🚪 그룹 채팅 나가기', () => {
      closePopover();
      confirmDialog('나가기', `'${conversation.name}'에서 나갈까? 다시 들어오려면 초대를 받아야 할 수 있어.`, '나가기', async () => {
        await api('DELETE', `/api/conversations/${conversation.id}/members/${state.me.id}`);
        await refreshConversations();
        go('#/home');
      });
    }, { danger: true }));
  }
  if (conversation.kind === 'space' && conversation.role === 'manager') {
    items.push(menuItem('🗑 스페이스 삭제', () => {
      closePopover();
      confirmDialog('스페이스 삭제', `'${conversation.name}'와 그 안의 모든 메시지와 파일이 모두에게서 영구히 사라져.`, '삭제', async () => {
        await api('DELETE', `/api/conversations/${conversation.id}`);
        await refreshConversations();
        go('#/home');
      });
    }, { danger: true }));
  }
  popover(anchor, items, { align: 'right' });
}

function openSpaceSettings(conversation) {
  const name = h('input', { maxlength: 128, value: conversation.name, required: true });
  const description = h('textarea', { maxlength: 150, rows: 2 }, conversation.description);
  const emoji = emojiChoice(conversation.emoji);
  const visibility = h('select', {},
    h('option', { value: 'private', selected: conversation.visibility === 'private' }, '비공개 — 초대한 사람만'),
    h('option', { value: 'public', selected: conversation.visibility === 'public' }, '공개 — 누구나 찾아서 참여'));
  openDialog('스페이스 설정', [
    h('label', {}, '스페이스 이름', name),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '아이콘'), emoji.element),
    h('label', {}, '설명', description),
    h('label', {}, '공개 범위', visibility),
  ], {
    submitLabel: '저장',
    onSubmit: async () => {
      await api('PATCH', `/api/conversations/${conversation.id}`, {
        name: name.value, description: description.value, emoji: emoji.value(), visibility: visibility.value,
      });
      await refreshConversations();
    },
  });
}

function openMembers(conversationId) {
  const conversation = state.conversations.get(conversationId);
  const canManage = conversation.kind === 'space' && conversation.role === 'manager';
  const picker = peoplePicker({ placeholder: '추가할 사람의 이름 또는 이메일', exclude: conversation.members.map((m) => m.id) });
  const list = h('ul', { class: 'member-list' }, conversation.members.map((m) => h('li', {},
    avatar(m, 36),
    h('div', { class: 'who' },
      h('strong', {}, m.id === state.me.id ? `${m.name} (나)` : m.name),
      h('span', { class: 'muted' }, [m.email, m.registered ? null : '초대됨'].filter(Boolean).join(' · '))),
    m.role === 'manager' && conversation.kind === 'space' ? h('span', { class: 'tag' }, '관리자') : null,
    canManage && m.id !== state.me.id
      ? h('button', { type: 'button', class: 'icon-btn', title: '관리', onclick: (event) => popover(event.currentTarget, [
        menuItem(m.role === 'manager' ? '일반 멤버로 바꾸기' : '관리자로 지정', run(async () => {
          closePopover();
          await api('PATCH', `/api/conversations/${conversationId}/members/${m.id}`, { role: m.role === 'manager' ? 'member' : 'manager' });
          await refreshConversations();
          openMembers(conversationId);
        })),
        menuItem('스페이스에서 내보내기', run(async () => {
          closePopover();
          await api('DELETE', `/api/conversations/${conversationId}/members/${m.id}`);
          await refreshConversations();
          openMembers(conversationId);
        }), { danger: true }),
      ], { align: 'right' }) }, '⋮')
      : null)));
  openDialog(`멤버 · ${conversation.name}`, [
    h('div', { class: 'field' }, h('span', { class: 'label' }, '사람 추가'), picker.element),
    list,
  ], {
    wide: true,
    submitLabel: '추가',
    onSubmit: async () => {
      const emails = picker.emails();
      if (!emails.length) throw new Error('추가할 사람을 골라 줘.');
      await api('POST', `/api/conversations/${conversationId}/members`, { emails });
      await refreshConversations();
      openMembers(conversationId);
      return true;
    },
  });
}

function searchInConversation(conversation) {
  const input = h('input', { type: 'search', placeholder: `${conversation.name}에서 검색` });
  const results = h('ul', { class: 'collection compact' });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run(async () => {
      const q = input.value.trim();
      if (!q) return results.replaceChildren();
      const found = await api('GET', `/api/search?q=${encodeURIComponent(q)}&conversation=${conversation.id}`);
      results.replaceChildren(...(found.length ? found.map((m) => h('li', {}, h('a', {
        href: m.threadId ? `#/chat/${conversation.id}/${m.threadId}` : `#/chat/${conversation.id}`,
        class: 'collection-item',
        onclick: () => { state.highlight = m.id; $('#dialog').close(); if (!m.threadId) setTimeout(() => scrollToMessage(m.id), 0); },
      }, h('div', { class: 'msg-head' }, h('strong', {}, m.author?.name), h('span', { class: 'muted' }, fullFormat.format(m.createdAt))),
      h('div', { class: 'msg-body' }, renderBody(m.body, m.mentions, state.me.id))))) : [h('li', { class: 'empty' }, '찾는 메시지가 없어.')]));
    }), 200);
  });
  openDialog('대화에서 검색', [input, results], { wide: true });
}

async function openConversation(id) {
  const conversation = state.conversations.get(id);
  const main = $('#main');
  const list = h('ol', { class: 'messages', id: 'message-list', 'aria-live': 'polite' });
  const scroller = h('div', { class: 'scroller', id: 'scroller' }, list);
  main.replaceChildren(
    h('header', { class: 'conv-head' }),
    scroller,
    h('div', { class: 'typing-line', id: 'typing-main' }),
    composer({ conversationId: id, threadId: null }),
  );
  renderConversationHeader(conversation);
  updateTitle();

  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop < 200) loadOlder(id);
  });

  if (!state.messages.has(id)) {
    list.append(h('li', { class: 'loading' }, '불러오는 중…'));
    const page = await run(() => api('GET', `/api/conversations/${id}/messages`))();
    if (!page) return;
    state.messages.set(id, { list: page.messages, hasMore: page.hasMore, loading: false });
  }
  if (state.view.id !== id) return;
  renderMessages(id);
  if (state.highlight) scrollToMessage(state.highlight);
  else scroller.scrollTop = scroller.scrollHeight;
  renderTyping(id);
  markActiveRead();
  main.querySelector('.composer textarea')?.focus();
}

async function loadOlder(id) {
  const store = state.messages.get(id);
  if (!store || !store.hasMore || store.loading) return;
  store.loading = true;
  const page = await run(() => api('GET', `/api/conversations/${id}/messages?before=${store.list[0].createdAt}`))();
  store.loading = false;
  if (!page) return;
  store.list = [...page.messages, ...store.list];
  store.hasMore = page.hasMore;
  if (state.view.id !== id) return;
  const scroller = $('#scroller');
  const from = scroller.scrollHeight - scroller.scrollTop;
  renderMessages(id);
  scroller.scrollTop = scroller.scrollHeight - from;
}

function scrollToMessage(id) {
  const el = document.querySelector(`#message-list [data-id="${id}"], #thread-list [data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2000);
  state.highlight = null;
}

/** 같은 사람이 5분 안에 이어서 보낸 메시지는 이름/사진을 생략한다. */
function continues(prev, message) {
  return prev && prev.kind === 'user' && message.kind === 'user' && prev.author?.id === message.author?.id
    && message.createdAt - prev.createdAt < 5 * 60 * 1000
    && new Date(prev.createdAt).toDateString() === new Date(message.createdAt).toDateString();
}

function renderMessages(id) {
  const store = state.messages.get(id);
  const list = $('#message-list');
  if (!store || !list) return;
  const conversation = state.conversations.get(id);
  const items = [];
  if (!store.hasMore) items.push(conversationIntro(conversation));
  else items.push(h('li', { class: 'loading' }, '이전 메시지 불러오는 중…'));
  let prev = null;
  for (const message of store.list) {
    if (!prev || new Date(prev.createdAt).toDateString() !== new Date(message.createdAt).toDateString()) {
      items.push(h('li', { class: 'day-sep' }, h('span', {}, dayLabel(message.createdAt))));
      prev = null;
    }
    items.push(messageItem(message, { compact: continues(prev, message), inThread: false }));
    prev = message;
  }
  const receipt = readReceipt(conversation, store.list);
  if (receipt) items.push(receipt);
  list.replaceChildren(...items);
}

function conversationIntro(conversation) {
  if (!conversation) return null;
  const text = conversation.kind === 'space'
    ? `${dayLabel(conversation.createdAt)}에 만든 스페이스야. 여기서 이야기를 나누고, 파일을 공유하고, 스레드로 답장할 수 있어.`
    : conversation.kind === 'group'
      ? '그룹 채팅의 시작이야.'
      : `${conversation.name}님과 나눈 대화의 시작이야.`;
  return h('li', { class: 'intro' }, groupAvatar(conversation, 64), h('h2', {}, conversation.name), h('p', { class: 'muted' }, text));
}

/** 1:1·그룹 대화에서 내 마지막 메시지를 누가 읽었는지 보여 준다. */
function readReceipt(conversation, list) {
  if (!conversation || conversation.kind === 'space') return null;
  const last = list.at(-1);
  if (!last || last.author?.id !== state.me.id) return null;
  const readers = conversation.members.filter((m) => m.id !== state.me.id && m.lastReadAt >= last.createdAt);
  if (!readers.length) return null;
  return h('li', { class: 'receipt', title: `읽음: ${readers.map((r) => r.name).join(', ')}` },
    h('span', { class: 'muted' }, '읽음'), readers.slice(0, 5).map((r) => avatar(r, 16, { presence: false })));
}

function messageItem(message, { compact = false, inThread = false } = {}) {
  if (message.kind === 'system') {
    return h('li', { class: 'system-msg', dataset: { id: message.id } }, h('span', {}, message.body), h('span', { class: 'muted' }, ` · ${timeFormat.format(message.createdAt)}`));
  }
  const mine = message.author?.id === state.me.id;
  const conversation = state.conversations.get(message.conversationId);
  const canDelete = mine || (conversation?.kind === 'space' && conversation.role === 'manager');

  const body = message.deleted
    ? h('div', { class: 'msg-body deleted' }, '🚫 삭제된 메시지야.')
    : h('div', { class: 'msg-body' }, renderBody(message.body, message.mentions, state.me.id));

  const attachments = message.attachments.length
    ? h('div', { class: 'attachments' }, message.attachments.map((a) => (a.mime.startsWith('image/') && a.mime !== 'image/svg+xml'
      ? h('a', { href: a.url, target: '_blank', rel: 'noopener', class: 'att-image' }, h('img', { src: a.url, alt: a.filename, loading: 'lazy' }))
      : h('a', { href: a.url, class: 'att-file', onclick: (event) => { event.preventDefault(); downloadFile(a); } },
        h('span', { class: 'att-icon' }, '📄'), h('span', { class: 'who' }, h('strong', {}, a.filename), h('span', { class: 'muted' }, fileSize(a.size)))))))
    : null;

  const reactions = message.reactions.length
    ? h('div', { class: 'reactions' },
      message.reactions.map((r) => h('button', {
        class: `reaction${r.userIds.includes(state.me.id) ? ' mine' : ''}`,
        title: r.users.join(', '),
        onclick: () => react(message.id, r.emoji),
      }, r.emoji, h('span', {}, r.count))),
      h('button', { class: 'reaction add', title: '반응 추가', onclick: (event) => emojiPicker(event.currentTarget, (e) => react(message.id, e)) }, '☺+'))
    : null;

  const replies = !inThread && message.replies.count
    ? h('button', { class: 'thread-summary', onclick: () => go(`#/chat/${message.conversationId}/${message.id}`) },
      h('span', { class: 'thread-people' }, message.replies.people.map((p) => avatar(p, 20, { presence: false }))),
      h('strong', {}, `답글 ${message.replies.count}개`),
      h('span', { class: 'muted' }, shortTime(message.replies.lastAt)))
    : null;

  const toolbar = message.deleted ? null : h('div', { class: 'msg-tools' },
    QUICK_REACTIONS.slice(0, 3).map((e) => h('button', { class: 'icon-btn', title: `${e} 반응`, onclick: () => react(message.id, e) }, e)),
    h('button', { class: 'icon-btn', title: '반응 추가', onclick: (event) => emojiPicker(event.currentTarget, (e) => react(message.id, e)) }, '☺'),
    !inThread && !message.threadId ? h('button', { class: 'icon-btn', title: '스레드에서 답장', onclick: () => go(`#/chat/${message.conversationId}/${message.id}`) }, '💬') : null,
    h('button', { class: `icon-btn${message.starred ? ' starred' : ''}`, title: message.starred ? '별표 해제' : '별표', onclick: () => star(message) }, message.starred ? '★' : '☆'),
    h('button', { class: 'icon-btn', title: '더보기', onclick: (event) => popover(event.currentTarget, [
      menuItem('📋 텍스트 복사', () => {
        closePopover();
        navigator.clipboard?.writeText(toEditable(message.body, message.mentions)).then(() => toast('복사했어.'));
      }),
      !inThread && !message.threadId ? menuItem('💬 스레드에서 답장', () => { closePopover(); go(`#/chat/${message.conversationId}/${message.id}`); }) : null,
      mine ? menuItem('✏️ 수정', () => { closePopover(); startEdit(message); }) : null,
      canDelete ? menuItem('🗑 삭제', () => {
        closePopover();
        confirmDialog('메시지 삭제', '이 메시지를 모두에게서 삭제할까?', '삭제', () => api('DELETE', `/api/messages/${message.id}`).then(applyMessageUpdate));
      }, { danger: true }) : null,
    ].filter(Boolean), { align: 'right' }) }, '⋮'));

  return h('li', { class: `msg${compact ? ' compact' : ''}${mine ? ' mine' : ''}`, dataset: { id: message.id } },
    compact ? h('span', { class: 'msg-gutter muted', title: fullFormat.format(message.createdAt) }, timeFormat.format(message.createdAt)) : avatar(message.author, 36),
    h('div', { class: 'msg-main' },
      compact ? null : h('div', { class: 'msg-head' },
        h('strong', {}, message.author?.name ?? '알 수 없음'),
        h('span', { class: 'muted', title: fullFormat.format(message.createdAt) }, timeFormat.format(message.createdAt))),
      h('div', { class: 'msg-content' }, body, message.editedAt && !message.deleted ? h('span', { class: 'muted edited' }, '(수정됨)') : null),
      attachments, reactions, replies),
    toolbar);
}

const react = run(async (messageId, emoji) => {
  applyMessageUpdate(await api('POST', `/api/messages/${messageId}/reactions`, { emoji }));
});

const star = run(async (message) => {
  const updated = await api('POST', `/api/messages/${message.id}/star`);
  applyMessageUpdate(updated);
  toast(updated.starred ? '별표표시했어.' : '별표를 해제했어.');
});

function startEdit(message) {
  const el = document.querySelector(`[data-id="${message.id}"] .msg-content`);
  if (!el) return;
  const textarea = h('textarea', { rows: 2, maxlength: 4000 }, toEditable(message.body, message.mentions));
  const editMentions = new Map(Object.entries(message.mentions).map(([id, name]) => [id === 'all' ? 'all' : name, id]));
  const cancel = () => applyMessageUpdate(message);
  const save = run(async () => {
    const body = fromEditable(textarea.value, editMentions);
    if (!body.trim()) return;
    applyMessageUpdate(await api('PATCH', `/api/messages/${message.id}`, { body }));
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); save(); }
    if (event.key === 'Escape') { event.stopPropagation(); cancel(); }
  });
  el.replaceChildren(h('div', { class: 'edit-box' }, textarea,
    h('div', { class: 'edit-actions' }, h('span', { class: 'muted' }, 'Esc 취소 · Enter 저장'),
      h('button', { class: 'btn text', onclick: cancel }, '취소'), h('button', { class: 'btn', onclick: save }, '저장'))));
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

/** 서버에서 바뀐 메시지 하나를 목록과 스레드에 반영한다. */
function applyMessageUpdate(message) {
  const keepStar = (old) => (old && message.starred === undefined ? old.starred : message.starred);
  const store = state.messages.get(message.conversationId);
  if (store) {
    const index = store.list.findIndex((m) => m.id === message.id);
    if (index >= 0) store.list[index] = { ...message, starred: keepStar(store.list[index]) };
  }
  if (state.thread?.rootId === message.id || state.thread?.list.some((m) => m.id === message.id)) {
    const index = state.thread.list.findIndex((m) => m.id === message.id);
    if (index >= 0) state.thread.list[index] = { ...message, starred: keepStar(state.thread.list[index]) };
    renderThreadMessages();
  }
  if (state.view.type === 'conversation' && state.view.id === message.conversationId) {
    const scroller = $('#scroller');
    const atBottom = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    renderMessages(message.conversationId);
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  }
}

// ───────────── 스레드 ─────────────

async function openThread(conversationId, rootId) {
  const panel = $('#thread');
  const conversation = state.conversations.get(conversationId);
  state.thread = { conversationId, rootId, list: [] };
  panel.hidden = false;
  $('#app').classList.add('thread-open');
  panel.replaceChildren(
    h('header', { class: 'thread-head' },
      h('div', {}, h('h2', {}, '스레드'), h('span', { class: 'muted' }, conversation?.name)),
      h('button', { class: 'icon-btn', 'aria-label': '스레드 닫기', onclick: () => go(`#/chat/${conversationId}`) }, '✕')),
    h('div', { class: 'scroller', id: 'thread-scroller' }, h('ol', { class: 'messages', id: 'thread-list' }, h('li', { class: 'loading' }, '불러오는 중…'))),
    h('div', { class: 'typing-line', id: 'typing-thread' }),
    composer({ conversationId, threadId: rootId }),
  );
  const page = await run(() => api('GET', `/api/conversations/${conversationId}/messages?thread=${rootId}`))();
  if (!page || state.thread?.rootId !== rootId) return;
  state.thread.list = page.messages;
  renderThreadMessages();
  const scroller = $('#thread-scroller');
  if (state.highlight) scrollToMessage(state.highlight);
  else scroller.scrollTop = scroller.scrollHeight;
  renderTyping(conversationId);
  panel.querySelector('.composer textarea')?.focus();
}

function renderThreadMessages() {
  const list = $('#thread-list');
  if (!list || !state.thread) return;
  const [root, ...replies] = state.thread.list;
  if (!root) return;
  const items = [messageItem(root, { inThread: true }),
    h('li', { class: 'day-sep thread-count' }, h('span', {}, replies.length ? `답글 ${replies.length}개` : '아직 답글이 없어'))];
  let prev = null;
  for (const reply of replies) {
    items.push(messageItem(reply, { compact: continues(prev, reply), inThread: true }));
    prev = reply;
  }
  list.replaceChildren(...items);
}

function closeThread() {
  state.thread = null;
  $('#thread').hidden = true;
  $('#thread').replaceChildren();
  $('#app').classList.remove('thread-open');
}

// ───────────── 메시지 입력창 ─────────────

function composer({ conversationId, threadId }) {
  const conversation = state.conversations.get(conversationId);
  const mentionMap = new Map(); // 화면에 보이는 "@이름" → 사용자 ID
  const pending = []; // 올린 첨부 파일
  const textarea = h('textarea', {
    rows: 1,
    maxlength: 4000,
    placeholder: threadId ? '답장' : conversation.kind === 'dm' ? `${conversation.name}님에게 메시지 보내기` : `${conversation.name}에 메시지 보내기`,
    'aria-label': '메시지',
  });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
  const tray = h('div', { class: 'attach-tray' });
  const suggest = h('ul', { class: 'mention-suggest', hidden: true });
  const sendBtn = h('button', { class: 'send-btn', type: 'submit', title: '보내기', disabled: true }, '➤');

  const updateSend = () => {
    sendBtn.disabled = !textarea.value.trim() && !pending.some((p) => p.id);
  };
  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  };
  const renderTray = () => {
    tray.replaceChildren(...pending.map((p) => h('span', { class: `chip file${p.id ? '' : ' uploading'}` },
      p.id ? '📎' : '⏳', p.name,
      h('button', { type: 'button', 'aria-label': '빼기', onclick: () => { pending.splice(pending.indexOf(p), 1); renderTray(); updateSend(); } }, '✕'))));
  };

  const upload = run(async (files) => {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) {
        toast(`${file.name}: 25MB까지 올릴 수 있어.`, { error: true });
        continue;
      }
      const entry = { name: file.name, id: null };
      pending.push(entry);
      renderTray();
      try {
        // 1) 서버에 자리를 만들고 1회용 토큰을 받아서 2) 브라우저가 Storage에 직접 올린다.
        const { attachment, upload: target } = await api('POST', '/api/uploads', {
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
        });
        const { error } = await sb.storage
          .from(target.bucket)
          .uploadToSignedUrl(target.path, target.token, file, { contentType: target.contentType });
        if (error) throw new Error(`올리지 못했어 (${error.message})`);
        entry.id = attachment.id;
      } catch (error) {
        pending.splice(pending.indexOf(entry), 1);
        toast(`${file.name}: ${error.message}`, { error: true });
      }
      renderTray();
      updateSend();
    }
  });

  // @멘션 자동 완성
  let suggestions = [];
  let selected = 0;
  const mentionQuery = () => {
    const before = textarea.value.slice(0, textarea.selectionStart);
    const match = before.match(/(^|\s)@([^\s@]{0,30})$/);
    return match ? match[2] : null;
  };
  const updateSuggest = () => {
    const q = mentionQuery();
    const current = state.conversations.get(conversationId);
    if (q === null || !current) {
      suggest.hidden = true;
      return;
    }
    const lower = q.toLowerCase();
    suggestions = current.members
      .filter((m) => m.id !== state.me.id && (m.name.toLowerCase().includes(lower) || m.email.includes(lower)))
      .slice(0, 8);
    if (current.kind !== 'dm' && 'all'.startsWith(lower)) suggestions.push({ id: 'all', name: 'all', email: '모두에게 알림' });
    if (!suggestions.length) {
      suggest.hidden = true;
      return;
    }
    selected = Math.min(selected, suggestions.length - 1);
    suggest.replaceChildren(...suggestions.map((m, i) => h('li', {},
      h('button', { type: 'button', class: i === selected ? 'on' : '', onmousedown: (event) => { event.preventDefault(); pick(m); } },
        m.id === 'all' ? h('span', { class: 'nav-icon' }, '@') : avatar(m, 24),
        h('strong', {}, m.name), h('span', { class: 'muted' }, m.email)))));
    suggest.hidden = false;
  };
  const pick = (member) => {
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${member.name} `);
    textarea.value = before + textarea.value.slice(caret);
    textarea.setSelectionRange(before.length, before.length);
    mentionMap.set(member.name, member.id);
    suggest.hidden = true;
    textarea.focus();
    updateSend();
  };

  // 입력 중 표시
  let typingTimer = null;
  let typingSent = false;
  const stopTyping = () => {
    clearTimeout(typingTimer);
    if (typingSent) sendTyping(conversationId, threadId, false);
    typingSent = false;
  };

  const send = run(async () => {
    if (pending.some((p) => !p.id)) return toast('파일을 올리는 중이야. 잠깐만.');
    if (state.conversations.get(conversationId)?.kind !== 'dm') mentionMap.set('all', 'all');
    const body = fromEditable(textarea.value, mentionMap);
    const attachmentIds = pending.map((p) => p.id);
    if (!body.trim() && !attachmentIds.length) return;
    stopTyping();
    sendBtn.disabled = true;
    try {
      const message = await api('POST', `/api/conversations/${conversationId}/messages`, { body, threadId, attachmentIds });
      textarea.value = '';
      pending.length = 0;
      mentionMap.clear();
      renderTray();
      grow();
      receiveMessage(message, { own: true });
    } finally {
      updateSend();
    }
  });

  textarea.addEventListener('input', () => {
    grow();
    updateSend();
    updateSuggest();
    if (!textarea.value) return stopTyping();
    if (!typingSent) {
      sendTyping(conversationId, threadId, true);
      typingSent = true;
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 3000);
  });
  textarea.addEventListener('keydown', (event) => {
    if (!suggest.hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
        return updateSuggest();
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        return pick(suggestions[selected]);
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        suggest.hidden = true;
        return undefined;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
    // 빈 입력창에서 ↑를 누르면 내 마지막 메시지를 고친다.
    if (event.key === 'ArrowUp' && !textarea.value) {
      const source = threadId ? state.thread?.list : state.messages.get(conversationId)?.list;
      const last = [...(source ?? [])].reverse().find((m) => m.author?.id === state.me.id && !m.deleted && m.kind === 'user');
      if (last) {
        event.preventDefault();
        startEdit(last);
      }
    }
  });
  textarea.addEventListener('blur', () => setTimeout(() => { suggest.hidden = true; }, 100));
  textarea.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length) {
      event.preventDefault();
      upload(files);
    }
  });
  fileInput.addEventListener('change', () => {
    upload([...fileInput.files]);
    fileInput.value = '';
  });

  const form = h('form', { class: 'composer', onsubmit: (event) => { event.preventDefault(); send(); } },
    suggest,
    h('div', { class: 'composer-box' },
      tray,
      textarea,
      h('div', { class: 'composer-tools' },
        h('button', { type: 'button', class: 'icon-btn', title: '파일 첨부', onclick: () => fileInput.click() }, '📎'),
        h('button', { type: 'button', class: 'icon-btn', title: '이모티콘', onclick: (event) => emojiPicker(event.currentTarget, (e) => {
          const at = textarea.selectionStart ?? textarea.value.length;
          textarea.value = textarea.value.slice(0, at) + e + textarea.value.slice(at);
          textarea.focus();
          textarea.setSelectionRange(at + e.length, at + e.length);
          updateSend();
        }) }, '☺'),
        h('button', { type: 'button', class: 'icon-btn', title: '서식 도움말', onclick: (event) => popover(event.currentTarget, h('div', { class: 'format-help' },
          h('strong', {}, '서식'), h('p', {}, '*굵게*  _기울임_  ~취소선~  `코드`'), h('p', {}, '```여러 줄 코드```'), h('p', {}, '@이름 으로 멘션, @all 로 모두에게'),
          h('p', {}, 'Shift+Enter 줄바꿈 · ↑ 마지막 메시지 수정'))) }, 'Aa'),
        fileInput,
        h('span', { class: 'spacer' }),
        sendBtn)),
  );
  // 파일을 끌어다 놓아도 올라간다.
  form.addEventListener('dragover', (event) => { event.preventDefault(); form.classList.add('drop'); });
  form.addEventListener('dragleave', () => form.classList.remove('drop'));
  form.addEventListener('drop', (event) => {
    event.preventDefault();
    form.classList.remove('drop');
    upload([...(event.dataTransfer?.files ?? [])]);
  });
  return form;
}

// ───────────── 받은 메시지 ─────────────

function receiveMessage(message, { own = false, mentioned = [] } = {}) {
  const conversation = state.conversations.get(message.conversationId);
  const store = state.messages.get(message.conversationId);
  const isActive = state.view.type === 'conversation' && state.view.id === message.conversationId;

  if (!message.threadId) {
    if (store && !store.list.some((m) => m.id === message.id)) {
      store.list.push(message);
      if (isActive) {
        const scroller = $('#scroller');
        const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
        renderMessages(message.conversationId);
        if (atBottom || own) scroller.scrollTop = scroller.scrollHeight;
      }
    }
  } else if (state.thread?.rootId === message.threadId && !state.thread.list.some((m) => m.id === message.id)) {
    state.thread.list.push(message);
    renderThreadMessages();
    const scroller = $('#thread-scroller');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  // 입력 중 표시는 메시지가 오면 지운다.
  if (message.author) clearTyping(message.conversationId, message.author.id);

  if (!own && message.author?.id !== state.me.id) {
    if (isActive && document.visibilityState === 'visible' && document.hasFocus()) markActiveRead();
    else notify(message, conversation, mentioned.includes(state.me.id));
  }
  refreshSoon();
}

function notify(message, conversation, mentionedMe) {
  if (!state.notify || !conversation || state.me.status === 'dnd') return;
  if (conversation.muted && !mentionedMe) return;
  if (message.kind !== 'user') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = conversation.kind === 'dm' ? message.author.name : `${message.author.name} · ${conversation.name}`;
  const body = toEditable(message.body, message.mentions) || '📎 파일을 보냈어';
  const n = new Notification(title, { body: body.slice(0, 140), icon: message.author.avatar || '/icon.svg', tag: message.conversationId });
  n.onclick = () => {
    window.focus();
    go(message.threadId ? `#/chat/${message.conversationId}/${message.threadId}` : `#/chat/${message.conversationId}`);
  };
}

let readTimer;
function markActiveRead() {
  const conversation = activeConversation();
  if (!conversation || document.visibilityState !== 'visible') return;
  clearTimeout(readTimer);
  readTimer = setTimeout(run(async () => {
    await api('POST', `/api/conversations/${conversation.id}/read`);
    conversation.unread = 0;
    conversation.mentionCount = 0;
    renderNav();
    updateTitle();
  }), 300);
}

// ───────────── 입력 중 ─────────────

function typingText(conversationId, threadId = undefined) {
  const map = state.typing.get(conversationId);
  if (!map?.size) return '';
  const names = [...map.values()].filter((t) => threadId === undefined || t.threadId === threadId).map((t) => t.name);
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]}님이 입력 중…`;
  if (names.length === 2) return `${names[0]}님, ${names[1]}님이 입력 중…`;
  return `${names.length}명이 입력 중…`;
}

function renderTyping(conversationId) {
  if (state.view.type === 'conversation' && state.view.id === conversationId) {
    const el = $('#typing-main');
    if (el) el.textContent = typingText(conversationId, null);
  }
  if (state.thread?.conversationId === conversationId) {
    const el = $('#typing-thread');
    if (el) el.textContent = typingText(conversationId, state.thread.rootId);
  }
  renderNav();
}

function clearTyping(conversationId, userId) {
  const map = state.typing.get(conversationId);
  const entry = map?.get(userId);
  if (!entry) return;
  clearTimeout(entry.timer);
  map.delete(userId);
  renderTyping(conversationId);
}

// ───────────── 실시간 연결 ─────────────

function sendTyping(conversationId, threadId, typing) {
  api('POST', `/api/conversations/${conversationId}/typing`, { threadId, typing }).catch(() => {});
}

/** 파일을 원래 이름 그대로 저장한다. */
const downloadFile = run(async (attachment) => {
  const { url, filename } = await api('GET', `/api/files/${attachment.id}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error('파일을 받지 못했어.');
  const href = URL.createObjectURL(await res.blob());
  const link = h('a', { href, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
});

function updatePresenceDots(userId) {
  const presence = presenceOf(userId);
  for (const dot of document.querySelectorAll(`[data-presence-user="${userId}"]`)) dot.className = `presence ${presence}`;
  const conversation = activeConversation();
  if (conversation && conversation.members.some((m) => m.id === userId)) {
    const sub = document.querySelector(`[data-sub="${conversation.id}"]`);
    if (sub) sub.textContent = memberSummary(conversation);
  }
}

/** 끊긴 사이에 온 메시지를 놓치지 않게 다시 받아 온다. */
const resync = run(async () => {
  state.messages.clear();
  await refreshConversations();
  if (state.view.type === 'conversation') {
    const scroller = $('#scroller');
    const keep = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120 : true;
    const page = await api('GET', `/api/conversations/${state.view.id}/messages`);
    state.messages.set(state.view.id, { list: page.messages, hasMore: page.hasMore, loading: false });
    renderMessages(state.view.id);
    if (keep && scroller) scroller.scrollTop = scroller.scrollHeight;
  }
});

/**
 * Supabase Realtime 구독.
 * - user:<내 ID> 비공개 채널: 서버가 보내는 새 메시지·수정·읽음·입력 중 등 (나만 받을 수 있음)
 * - chat:everyone 채널: 누가 접속해 있는지(presence)와 상태 변경
 */
function connectRealtime() {
  const handlers = {
    'message:new': ({ message, mentioned }) => receiveMessage(message, { mentioned }),
    'message:update': ({ message }) => {
      applyMessageUpdate({ ...message, starred: undefined });
      refreshSoon();
    },
    'conversations:changed': refreshSoon,
    'conversation:removed': ({ id }) => {
      state.messages.delete(id);
      if (state.view.type === 'conversation' && state.view.id === id) {
        toast('이 대화에 더 이상 접근할 수 없어.');
        go('#/home');
      }
      refreshSoon();
    },
    typing: ({ conversationId, threadId, userId, name, typing }) => {
      const map = state.typing.get(conversationId) ?? new Map();
      state.typing.set(conversationId, map);
      clearTimeout(map.get(userId)?.timer);
      if (typing) map.set(userId, { name, threadId, timer: setTimeout(() => clearTyping(conversationId, userId), 6000) });
      else map.delete(userId);
      renderTyping(conversationId);
    },
    read: ({ conversationId, userId, at }) => {
      const conversation = state.conversations.get(conversationId);
      const member = conversation?.members.find((m) => m.id === userId);
      if (!member) return;
      member.lastReadAt = at;
      if (state.view.type === 'conversation' && state.view.id === conversationId) renderMessages(conversationId);
    },
  };

  const mine = sb.channel(`user:${state.me.id}`, { config: { private: true } });
  for (const [event, handle] of Object.entries(handlers)) {
    mine.on('broadcast', { event }, ({ payload }) => handle(payload ?? {}));
  }
  let everConnected = false;
  mine.subscribe((status) => {
    const up = status === 'SUBSCRIBED';
    if (up && everConnected && !state.realtimeUp) resync();
    if (up) everConnected = true;
    if (state.realtimeUp !== up && status !== 'CLOSED') {
      state.realtimeUp = up;
      renderTopbar();
      updatePresenceDots(state.me.id);
      if (!up && everConnected) toast('실시간 연결이 끊겼어. 다시 연결하는 중…');
    }
  });

  const everyone = sb.channel('chat:everyone', { config: { private: true, presence: { key: state.me.id } } });
  everyone
    .on('presence', { event: 'sync' }, () => {
      const before = state.online;
      state.online = new Set(Object.keys(everyone.presenceState()));
      for (const id of new Set([...before, ...state.online])) updatePresenceDots(id);
    })
    .on('broadcast', { event: 'status' }, ({ payload }) => {
      const { userId, status, statusText } = payload ?? {};
      if (!userId) return;
      state.statuses.set(userId, status);
      if (userId === state.me.id) {
        state.me.status = status;
        state.me.statusText = statusText;
        renderTopbar();
      }
      for (const conversation of state.conversations.values()) {
        const member = conversation.members.find((m) => m.id === userId);
        if (member) member.statusText = statusText;
      }
      updatePresenceDots(userId);
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await everyone.track({ at: Date.now() });
    });
}

boot();
