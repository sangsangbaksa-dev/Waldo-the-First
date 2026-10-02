import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';

export const LIMITS = {
  name: 80,
  spaceName: 128,
  description: 150,
  message: 4000,
  statusText: 80,
  pageSize: 50,
  attachmentsPerMessage: 10,
};

export const STATUSES = ['auto', 'away', 'dnd'];

// 메시지 본문 안의 멘션 토큰: <@사용자ID> 또는 <@all>
const MENTION = /<@([0-9a-f-]{36}|all)>/g;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ChatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new ChatError(status, message);
};

function text(value, max, label, { required = true } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (required && !v) fail(400, `${label}을(를) 입력해 줘.`);
  if (v.length > max) fail(400, `${label}은(는) ${max}자까지야.`);
  return v;
}

export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) fail(400, `올바른 이메일이 아니야: ${value}`);
  return email;
}

const placeholders = (n) => Array(n).fill('?').join(',');

export class ChatService {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
  }

  q(sql) {
    return this.db.prepare(sql);
  }

  // ───────────── 사용자 ─────────────

  publicUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      avatar: row.avatar,
      registered: Boolean(row.registered),
      status: row.status,
      statusText: row.status_text,
      lastSeen: row.last_seen,
    };
  }

  getUser(id) {
    return this.publicUser(this.q('SELECT * FROM users WHERE id = ?').get(id));
  }

  getUserByEmail(email) {
    return this.publicUser(this.q('SELECT * FROM users WHERE email = ?').get(email));
  }

  /** 아직 로그인한 적 없는 사람도 이메일로 초대할 수 있게 자리만 만들어 둔다. */
  ensureUser(email) {
    const normalized = normalizeEmail(email);
    const existing = this.getUserByEmail(normalized);
    if (existing) return existing;
    const id = randomUUID();
    this.q('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      normalized,
      normalized.split('@')[0],
      this.now(),
    );
    return this.getUser(id);
  }

  /** 구글 로그인(또는 개발용 로그인)으로 들어온 사람을 등록하거나 갱신한다. */
  signIn({ email, name, avatar = null }) {
    const user = this.ensureUser(email);
    const displayName = text(name || user.name, LIMITS.name, '이름');
    this.q('UPDATE users SET name = ?, avatar = ?, registered = 1, last_seen = ? WHERE id = ?').run(
      displayName,
      avatar,
      this.now(),
      user.id,
    );
    return this.getUser(user.id);
  }

  searchUsers(viewerId, query = '') {
    const like = `%${query.trim().toLowerCase()}%`;
    return this.q(
      `SELECT * FROM users
       WHERE id != ? AND (lower(name) LIKE ? OR email LIKE ?)
       ORDER BY registered DESC, name COLLATE NOCASE LIMIT 20`,
    )
      .all(viewerId, like, like)
      .map((row) => this.publicUser(row));
  }

  setStatus(userId, { status, statusText }) {
    const user = this.getUser(userId);
    const next = status ?? user.status;
    if (!STATUSES.includes(next)) fail(400, '알 수 없는 상태야.');
    const note = statusText === undefined ? user.statusText : text(statusText, LIMITS.statusText, '상태 메시지', { required: false });
    this.q('UPDATE users SET status = ?, status_text = ? WHERE id = ?').run(next, note, userId);
    return this.getUser(userId);
  }

  touch(userId) {
    this.q('UPDATE users SET last_seen = ? WHERE id = ?').run(this.now(), userId);
  }

  // ───────────── 세션 ─────────────

  createSession(userId, ttlMs = 30 * 24 * 60 * 60 * 1000) {
    const token = randomUUID() + randomUUID();
    this.q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, this.now() + ttlMs);
    return token;
  }

  userForSession(token) {
    if (!token) return null;
    const row = this.q('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
    if (!row) return null;
    if (row.expires_at < this.now()) {
      this.deleteSession(token);
      return null;
    }
    return this.getUser(row.user_id);
  }

  deleteSession(token) {
    this.q('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // ───────────── 대화방 ─────────────

  membership(userId, conversationId) {
    return this.q('SELECT * FROM members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId);
  }

  requireMember(userId, conversationId) {
    const member = this.membership(userId, conversationId);
    if (!member) fail(404, '대화를 찾을 수 없어.');
    return member;
  }

  requireManager(userId, conversationId) {
    const conversation = this.conversationRow(conversationId);
    const member = this.requireMember(userId, conversationId);
    if (conversation.kind !== 'space') fail(400, '스페이스에서만 할 수 있어.');
    if (member.role !== 'manager') fail(403, '스페이스 관리자만 할 수 있어.');
    return conversation;
  }

  conversationRow(id) {
    const row = this.q('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!row) fail(404, '대화를 찾을 수 없어.');
    return row;
  }

  memberIds(conversationId) {
    return this.q('SELECT user_id FROM members WHERE conversation_id = ?')
      .all(conversationId)
      .map((r) => r.user_id);
  }

  members(conversationId) {
    return this.q(
      `SELECT u.*, m.role, m.joined_at, m.last_read_at FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = ? ORDER BY m.role = 'manager' DESC, u.name COLLATE NOCASE`,
    )
      .all(conversationId)
      .map((row) => ({ ...this.publicUser(row), role: row.role, joinedAt: row.joined_at, lastReadAt: row.last_read_at }));
  }

  addMemberRow(conversationId, userId, role = 'member') {
    this.q(
      `INSERT INTO members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET hidden = 0`,
    ).run(conversationId, userId, role, this.now(), this.now());
  }

  /** 1:1 대화 또는 그룹 대화를 연다. 같은 사람들끼리의 대화가 이미 있으면 그걸 돌려준다. */
  openDirect(userId, emails) {
    const list = [...new Set((Array.isArray(emails) ? emails : [emails]).map(normalizeEmail))];
    const others = list.map((email) => this.ensureUser(email)).filter((u) => u.id !== userId);
    if (others.length === 0) fail(400, '대화할 사람을 한 명 이상 골라 줘.');
    const kind = others.length === 1 ? 'dm' : 'group';
    const key = `${kind}:${[userId, ...others.map((u) => u.id)].sort().join(',')}`;

    const existing = this.q('SELECT id FROM conversations WHERE dm_key = ?').get(key);
    if (existing) {
      this.q('UPDATE members SET hidden = 0 WHERE conversation_id = ? AND user_id = ?').run(existing.id, userId);
      return { conversation: this.getConversation(userId, existing.id), created: false };
    }

    const id = randomUUID();
    transaction(this.db, () => {
      this.q(
        'INSERT INTO conversations (id, kind, dm_key, created_by, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, kind, key, userId, this.now(), this.now());
      for (const uid of [userId, ...others.map((u) => u.id)]) this.addMemberRow(id, uid);
    });
    return { conversation: this.getConversation(userId, id), created: true };
  }

  createSpace(userId, { name, description = '', emoji = null, visibility = 'private', memberEmails = [] }) {
    const spaceName = text(name, LIMITS.spaceName, '스페이스 이름');
    const about = text(description, LIMITS.description, '설명', { required: false });
    if (!['private', 'public'].includes(visibility)) fail(400, '공개 범위가 올바르지 않아.');
    const invited = [...new Set(memberEmails.map(normalizeEmail))].map((email) => this.ensureUser(email));

    const id = randomUUID();
    transaction(this.db, () => {
      this.q(
        `INSERT INTO conversations (id, kind, name, description, emoji, visibility, created_by, created_at, last_message_at)
         VALUES (?, 'space', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, spaceName, about, emoji || null, visibility, userId, this.now(), this.now());
      this.addMemberRow(id, userId, 'manager');
      for (const user of invited) if (user.id !== userId) this.addMemberRow(id, user.id);
    });
    this.systemMessage(id, `${this.getUser(userId).name}님이 스페이스를 만들었어.`);
    return this.getConversation(userId, id);
  }

  updateSpace(userId, conversationId, { name, description, emoji, visibility }) {
    const conversation = this.requireManager(userId, conversationId);
    const next = {
      name: name === undefined ? conversation.name : text(name, LIMITS.spaceName, '스페이스 이름'),
      description:
        description === undefined ? conversation.description : text(description, LIMITS.description, '설명', { required: false }),
      emoji: emoji === undefined ? conversation.emoji : emoji || null,
      visibility: visibility === undefined ? conversation.visibility : visibility,
    };
    if (!['private', 'public'].includes(next.visibility)) fail(400, '공개 범위가 올바르지 않아.');
    this.q('UPDATE conversations SET name = ?, description = ?, emoji = ?, visibility = ? WHERE id = ?').run(
      next.name,
      next.description,
      next.emoji,
      next.visibility,
      conversationId,
    );
    if (next.name !== conversation.name) {
      this.systemMessage(conversationId, `${this.getUser(userId).name}님이 스페이스 이름을 '${next.name}'(으)로 바꿨어.`);
    }
    return this.getConversation(userId, conversationId);
  }

  deleteSpace(userId, conversationId) {
    this.requireManager(userId, conversationId);
    const memberIds = this.memberIds(conversationId);
    const files = this.q(
      'SELECT a.path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?',
    ).all(conversationId);
    this.q('DELETE FROM conversations WHERE id = ?').run(conversationId);
    return { memberIds, files: files.map((f) => f.path) };
  }

  addMembers(userId, conversationId, emails) {
    const conversation = this.conversationRow(conversationId);
    this.requireMember(userId, conversationId);
    if (conversation.kind === 'dm') fail(400, '1:1 대화에는 사람을 더할 수 없어. 새 그룹 대화를 만들어 줘.');
    const actor = this.getUser(userId);
    const added = [];
    for (const email of [...new Set(emails.map(normalizeEmail))]) {
      const user = this.ensureUser(email);
      if (this.membership(user.id, conversationId)) continue;
      this.addMemberRow(conversationId, user.id);
      added.push(user);
    }
    if (added.length) {
      // 그룹 대화에 사람이 늘면 더 이상 "이 사람들끼리의 대화"가 아니다.
      if (conversation.kind === 'group') this.q('UPDATE conversations SET dm_key = NULL WHERE id = ?').run(conversationId);
      this.systemMessage(conversationId, `${actor.name}님이 ${added.map((u) => u.name).join(', ')}님을 추가했어.`);
    }
    return added;
  }

  joinSpace(userId, conversationId) {
    const conversation = this.conversationRow(conversationId);
    if (conversation.kind !== 'space' || conversation.visibility !== 'public') fail(404, '대화를 찾을 수 없어.');
    if (!this.membership(userId, conversationId)) {
      this.addMemberRow(conversationId, userId);
      this.systemMessage(conversationId, `${this.getUser(userId).name}님이 참여했어.`);
    }
    return this.getConversation(userId, conversationId);
  }

  /** 다른 사람을 내보내거나(관리자) 스스로 나간다. */
  removeMember(userId, conversationId, targetId) {
    const conversation = this.conversationRow(conversationId);
    const self = userId === targetId;
    if (conversation.kind === 'dm') fail(400, '1:1 대화는 나갈 수 없어. 대화 숨기기를 써 줘.');
    if (self) this.requireMember(userId, conversationId);
    else if (conversation.kind === 'space') this.requireManager(userId, conversationId);
    else fail(403, '그룹 대화에서는 스스로만 나갈 수 있어.');

    const target = this.membership(targetId, conversationId);
    if (!target) fail(404, '그 사람은 이 대화에 없어.');
    this.q('DELETE FROM members WHERE conversation_id = ? AND user_id = ?').run(conversationId, targetId);

    // 마지막 관리자가 나가면 가장 오래된 멤버를 관리자로 올린다.
    if (conversation.kind === 'space' && target.role === 'manager') {
      const managers = this.q("SELECT COUNT(*) n FROM members WHERE conversation_id = ? AND role = 'manager'").get(conversationId);
      if (managers.n === 0) {
        this.q(
          `UPDATE members SET role = 'manager' WHERE conversation_id = ? AND user_id =
           (SELECT user_id FROM members WHERE conversation_id = ? ORDER BY joined_at LIMIT 1)`,
        ).run(conversationId, conversationId);
      }
    }
    if (conversation.kind === 'group') this.q('UPDATE conversations SET dm_key = NULL WHERE id = ?').run(conversationId);

    const name = this.getUser(targetId).name;
    this.systemMessage(conversationId, self ? `${name}님이 나갔어.` : `${this.getUser(userId).name}님이 ${name}님을 내보냈어.`);
  }

  setRole(userId, conversationId, targetId, role) {
    this.requireManager(userId, conversationId);
    if (!['manager', 'member'].includes(role)) fail(400, '알 수 없는 역할이야.');
    if (!this.membership(targetId, conversationId)) fail(404, '그 사람은 이 대화에 없어.');
    if (role === 'member') {
      const managers = this.q("SELECT COUNT(*) n FROM members WHERE conversation_id = ? AND role = 'manager'").get(conversationId);
      if (managers.n <= 1 && this.membership(targetId, conversationId).role === 'manager') {
        fail(400, '스페이스에는 관리자가 한 명 이상 있어야 해.');
      }
    }
    this.q('UPDATE members SET role = ? WHERE conversation_id = ? AND user_id = ?').run(role, conversationId, targetId);
  }

  setPreferences(userId, conversationId, { muted, pinned, hidden }) {
    const member = this.requireMember(userId, conversationId);
    const flag = (value, current) => (value === undefined ? current : value ? 1 : 0);
    this.q('UPDATE members SET muted = ?, pinned = ?, hidden = ? WHERE conversation_id = ? AND user_id = ?').run(
      flag(muted, member.muted),
      flag(pinned, member.pinned),
      flag(hidden, member.hidden),
      conversationId,
      userId,
    );
    return this.getConversation(userId, conversationId);
  }

  markRead(userId, conversationId) {
    this.requireMember(userId, conversationId);
    const at = this.now();
    this.q('UPDATE members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(at, conversationId, userId);
    return at;
  }

  listPublicSpaces(userId, query = '') {
    const like = `%${query.trim().toLowerCase()}%`;
    return this.q(
      `SELECT c.*, (SELECT COUNT(*) FROM members WHERE conversation_id = c.id) AS member_count
       FROM conversations c
       WHERE c.kind = 'space' AND c.visibility = 'public' AND lower(c.name) LIKE ?
         AND NOT EXISTS (SELECT 1 FROM members WHERE conversation_id = c.id AND user_id = ?)
       ORDER BY c.last_message_at DESC LIMIT 50`,
    )
      .all(like, userId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        emoji: row.emoji,
        memberCount: row.member_count,
      }));
  }

  summarize(userId, row) {
    const members = this.members(row.id);
    const others = members.filter((m) => m.id !== userId);
    const unread = this.q(
      `SELECT COUNT(*) n FROM messages
       WHERE conversation_id = ? AND thread_id IS NULL AND kind = 'user' AND deleted = 0
         AND created_at > ? AND user_id != ?`,
    ).get(row.id, row.last_read_at, userId).n;
    const mentionCount = this.q(
      `SELECT COUNT(*) n FROM mentions x JOIN messages m ON m.id = x.message_id
       WHERE m.conversation_id = ? AND x.user_id = ? AND m.created_at > ? AND m.deleted = 0`,
    ).get(row.id, userId, row.last_read_at).n;
    const last = this.q(
      `SELECT m.body, m.kind, m.deleted, u.name FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = ? AND m.thread_id IS NULL ORDER BY m.created_at DESC LIMIT 1`,
    ).get(row.id);

    let name = row.name;
    if (row.kind !== 'space') name = others.map((m) => m.name).join(', ') || '나';
    return {
      id: row.id,
      kind: row.kind,
      name,
      description: row.description,
      emoji: row.emoji,
      visibility: row.visibility,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      role: row.role,
      muted: Boolean(row.muted),
      pinned: Boolean(row.pinned),
      hidden: Boolean(row.hidden),
      lastReadAt: row.last_read_at,
      unread,
      mentionCount,
      members,
      lastMessage: last
        ? { author: last.name, body: last.deleted ? '' : last.body, kind: last.kind, deleted: Boolean(last.deleted) }
        : null,
    };
  }

  listConversations(userId) {
    return this.q(
      `SELECT c.*, m.role, m.muted, m.pinned, m.hidden, m.last_read_at
       FROM conversations c JOIN members m ON m.conversation_id = c.id
       WHERE m.user_id = ? ORDER BY m.pinned DESC, c.last_message_at DESC`,
    )
      .all(userId)
      .map((row) => this.summarize(userId, row));
  }

  getConversation(userId, conversationId) {
    this.requireMember(userId, conversationId);
    const row = this.q(
      `SELECT c.*, m.role, m.muted, m.pinned, m.hidden, m.last_read_at
       FROM conversations c JOIN members m ON m.conversation_id = c.id
       WHERE c.id = ? AND m.user_id = ?`,
    ).get(conversationId, userId);
    return this.summarize(userId, row);
  }

  // ───────────── 메시지 ─────────────

  systemMessage(conversationId, body) {
    const id = randomUUID();
    const at = this.now();
    this.q("INSERT INTO messages (id, conversation_id, kind, body, created_at) VALUES (?, ?, 'system', ?, ?)").run(
      id,
      conversationId,
      body,
      at,
    );
    this.q('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(at, conversationId);
    return id;
  }

  messageRow(messageId) {
    const row = this.q('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!row) fail(404, '메시지를 찾을 수 없어.');
    return row;
  }

  /** 메시지 여러 개를 화면에 쓸 모양으로 바꾼다. 반응, 첨부, 답글 수 등을 한 번에 붙인다. */
  hydrate(viewerId, rows) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const inList = placeholders(ids.length);

    const users = new Map();
    const userOf = (id) => {
      if (!id) return null;
      if (!users.has(id)) users.set(id, this.getUser(id));
      return users.get(id);
    };

    const reactions = new Map();
    for (const r of this.q(
      `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${inList}) ORDER BY created_at`,
    ).all(...ids)) {
      const byEmoji = reactions.get(r.message_id) ?? new Map();
      const entry = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, users: [], userIds: [], mine: false };
      entry.count += 1;
      entry.users.push(userOf(r.user_id)?.name);
      entry.userIds.push(r.user_id);
      if (r.user_id === viewerId) entry.mine = true;
      byEmoji.set(r.emoji, entry);
      reactions.set(r.message_id, byEmoji);
    }

    const attachments = new Map();
    for (const a of this.q(
      `SELECT id, message_id, filename, mime, size FROM attachments WHERE message_id IN (${inList}) ORDER BY created_at`,
    ).all(...ids)) {
      const list = attachments.get(a.message_id) ?? [];
      list.push({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: `/files/${a.id}` });
      attachments.set(a.message_id, list);
    }

    const replies = new Map();
    for (const r of this.q(
      `SELECT thread_id, COUNT(*) n, MAX(created_at) last, GROUP_CONCAT(DISTINCT user_id) people
       FROM messages WHERE thread_id IN (${inList}) AND deleted = 0 GROUP BY thread_id`,
    ).all(...ids)) {
      replies.set(r.thread_id, {
        count: r.n,
        lastAt: r.last,
        people: (r.people ?? '').split(',').filter(Boolean).slice(0, 3).map((id) => userOf(id)),
      });
    }

    const starred = new Set(
      this.q(`SELECT message_id FROM stars WHERE user_id = ? AND message_id IN (${inList})`)
        .all(viewerId, ...ids)
        .map((r) => r.message_id),
    );

    return rows.map((row) => {
      const mentions = {};
      if (!row.deleted) {
        for (const [, id] of row.body.matchAll(MENTION)) {
          mentions[id] = id === 'all' ? 'all' : (userOf(id)?.name ?? '알 수 없음');
        }
      }
      return {
        id: row.id,
        conversationId: row.conversation_id,
        threadId: row.thread_id,
        kind: row.kind,
        author: userOf(row.user_id),
        body: row.deleted ? '' : row.body,
        mentions,
        createdAt: row.created_at,
        editedAt: row.edited_at,
        deleted: Boolean(row.deleted),
        reactions: [...(reactions.get(row.id)?.values() ?? [])],
        attachments: row.deleted ? [] : (attachments.get(row.id) ?? []),
        replies: replies.get(row.id) ?? { count: 0, lastAt: null, people: [] },
        starred: starred.has(row.id),
      };
    });
  }

  getMessage(viewerId, messageId) {
    const row = this.messageRow(messageId);
    this.requireMember(viewerId, row.conversation_id);
    return this.hydrate(viewerId, [row])[0];
  }

  listMessages(userId, conversationId, { before, threadId } = {}) {
    this.requireMember(userId, conversationId);
    if (threadId) {
      const root = this.messageRow(threadId);
      if (root.conversation_id !== conversationId) fail(404, '스레드를 찾을 수 없어.');
      const replies = this.q('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at').all(threadId);
      return { messages: this.hydrate(userId, [root, ...replies]), hasMore: false };
    }
    const rows = this.q(
      `SELECT * FROM messages WHERE conversation_id = ? AND thread_id IS NULL AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(conversationId, before ?? Number.MAX_SAFE_INTEGER, LIMITS.pageSize + 1);
    const hasMore = rows.length > LIMITS.pageSize;
    return { messages: this.hydrate(userId, rows.slice(0, LIMITS.pageSize).reverse()), hasMore };
  }

  /**
   * 메시지를 보낸다. 본문의 <@id>, <@all> 토큰으로 멘션을 기록한다.
   * 돌려주는 값에 멘션된 사람 목록을 함께 실어 알림에 쓴다.
   */
  sendMessage(userId, conversationId, { body = '', threadId = null, attachmentIds = [] }) {
    this.requireMember(userId, conversationId);
    const content = typeof body === 'string' ? body.trim() : '';
    if (content.length > LIMITS.message) fail(400, `메시지는 ${LIMITS.message}자까지야.`);
    const ids = [...new Set(Array.isArray(attachmentIds) ? attachmentIds : [])];
    if (ids.length > LIMITS.attachmentsPerMessage) fail(400, `파일은 한 번에 ${LIMITS.attachmentsPerMessage}개까지야.`);
    if (!content && ids.length === 0) fail(400, '빈 메시지는 보낼 수 없어.');

    if (threadId) {
      const root = this.messageRow(threadId);
      if (root.conversation_id !== conversationId || root.thread_id) fail(400, '답장할 수 없는 메시지야.');
    }

    const files = ids.map((id) => {
      const file = this.q('SELECT * FROM attachments WHERE id = ?').get(id);
      if (!file || file.user_id !== userId || file.message_id) fail(400, '첨부 파일을 찾을 수 없어.');
      return file;
    });

    const memberIds = new Set(this.memberIds(conversationId));
    const mentioned = new Set();
    for (const [, id] of content.matchAll(MENTION)) {
      if (id === 'all') memberIds.forEach((m) => mentioned.add(m));
      else if (memberIds.has(id)) mentioned.add(id);
    }
    mentioned.delete(userId);

    const id = randomUUID();
    const at = this.now();
    transaction(this.db, () => {
      this.q('INSERT INTO messages (id, conversation_id, user_id, thread_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        conversationId,
        userId,
        threadId,
        content,
        at,
      );
      for (const file of files) this.q('UPDATE attachments SET message_id = ? WHERE id = ?').run(id, file.id);
      for (const uid of mentioned) this.q('INSERT INTO mentions (message_id, user_id) VALUES (?, ?)').run(id, uid);
      this.q('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(at, conversationId);
      // 보낸 사람은 자기 메시지를 읽은 것으로, 숨겨 둔 사람에게는 다시 보이게.
      this.q('UPDATE members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(at, conversationId, userId);
      this.q('UPDATE members SET hidden = 0 WHERE conversation_id = ?').run(conversationId);
    });

    return { message: this.getMessage(userId, id), mentioned: [...mentioned] };
  }

  editMessage(userId, messageId, body) {
    const row = this.messageRow(messageId);
    this.requireMember(userId, row.conversation_id);
    if (row.user_id !== userId || row.kind !== 'user') fail(403, '내 메시지만 고칠 수 있어.');
    if (row.deleted) fail(400, '삭제된 메시지야.');
    const content = typeof body === 'string' ? body.trim() : '';
    if (!content) fail(400, '빈 메시지로 고칠 수 없어. 지우려면 삭제를 써 줘.');
    if (content.length > LIMITS.message) fail(400, `메시지는 ${LIMITS.message}자까지야.`);

    const memberIds = new Set(this.memberIds(row.conversation_id));
    transaction(this.db, () => {
      this.q('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(content, this.now(), messageId);
      this.q('DELETE FROM mentions WHERE message_id = ?').run(messageId);
      const mentioned = new Set();
      for (const [, id] of content.matchAll(MENTION)) {
        if (id === 'all') memberIds.forEach((m) => mentioned.add(m));
        else if (memberIds.has(id)) mentioned.add(id);
      }
      mentioned.delete(userId);
      for (const uid of mentioned) this.q('INSERT INTO mentions (message_id, user_id) VALUES (?, ?)').run(messageId, uid);
    });
    return this.getMessage(userId, messageId);
  }

  deleteMessage(userId, messageId) {
    const row = this.messageRow(messageId);
    const member = this.requireMember(userId, row.conversation_id);
    const conversation = this.conversationRow(row.conversation_id);
    const canModerate = conversation.kind === 'space' && member.role === 'manager';
    if (row.kind !== 'user' || (row.user_id !== userId && !canModerate)) fail(403, '이 메시지는 지울 수 없어.');
    const files = this.q('SELECT path FROM attachments WHERE message_id = ?').all(messageId).map((f) => f.path);
    transaction(this.db, () => {
      this.q("UPDATE messages SET deleted = 1, body = '' WHERE id = ?").run(messageId);
      this.q('DELETE FROM attachments WHERE message_id = ?').run(messageId);
      this.q('DELETE FROM reactions WHERE message_id = ?').run(messageId);
      this.q('DELETE FROM mentions WHERE message_id = ?').run(messageId);
      this.q('DELETE FROM stars WHERE message_id = ?').run(messageId);
    });
    return { message: this.getMessage(userId, messageId), files };
  }

  toggleReaction(userId, messageId, emoji) {
    const row = this.messageRow(messageId);
    this.requireMember(userId, row.conversation_id);
    if (row.deleted || row.kind !== 'user') fail(400, '이 메시지에는 반응할 수 없어.');
    const value = typeof emoji === 'string' ? emoji.trim() : '';
    if (!value || value.length > 16) fail(400, '이모티콘이 올바르지 않아.');
    const exists = this.q('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(messageId, userId, value);
    if (exists) this.q('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, value);
    else this.q('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(messageId, userId, value, this.now());
    return this.getMessage(userId, messageId);
  }

  toggleStar(userId, messageId) {
    const row = this.messageRow(messageId);
    this.requireMember(userId, row.conversation_id);
    if (row.deleted || row.kind !== 'user') fail(400, '이 메시지는 별표할 수 없어.');
    const exists = this.q('SELECT 1 FROM stars WHERE message_id = ? AND user_id = ?').get(messageId, userId);
    if (exists) this.q('DELETE FROM stars WHERE message_id = ? AND user_id = ?').run(messageId, userId);
    else this.q('INSERT INTO stars (message_id, user_id, created_at) VALUES (?, ?, ?)').run(messageId, userId, this.now());
    return this.getMessage(userId, messageId);
  }

  /** 내가 아직 들어가 있는 대화의 메시지만 남긴다. */
  visible(userId, rows) {
    return this.hydrate(
      userId,
      rows.filter((r) => this.membership(userId, r.conversation_id)),
    );
  }

  listStarred(userId) {
    return this.visible(
      userId,
      this.q(
        `SELECT m.* FROM stars s JOIN messages m ON m.id = s.message_id
         WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 100`,
      ).all(userId),
    );
  }

  listMentions(userId) {
    return this.visible(
      userId,
      this.q(
        `SELECT m.* FROM mentions x JOIN messages m ON m.id = x.message_id
         WHERE x.user_id = ? AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 100`,
      ).all(userId),
    );
  }

  search(userId, query, { conversationId } = {}) {
    const term = typeof query === 'string' ? query.trim() : '';
    if (!term) return [];
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.q(
      `SELECT m.* FROM messages m JOIN members mb ON mb.conversation_id = m.conversation_id AND mb.user_id = ?
       WHERE m.kind = 'user' AND m.deleted = 0 AND m.body LIKE ? ESCAPE '\\'
         AND (? IS NULL OR m.conversation_id = ?)
       ORDER BY m.created_at DESC LIMIT 50`,
    ).all(userId, like, conversationId ?? null, conversationId ?? null);
    return this.hydrate(userId, rows);
  }

  // ───────────── 첨부 파일 ─────────────

  createAttachment(userId, { filename, mime, size, path }) {
    const id = randomUUID();
    this.q(
      'INSERT INTO attachments (id, user_id, filename, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, userId, filename, mime, size, path, this.now());
    return { id, filename, mime, size, url: `/files/${id}` };
  }

  /** 올린 사람이거나, 파일이 올라간 대화의 멤버여야 받을 수 있다. */
  attachmentFor(userId, id) {
    const file = this.q(
      'SELECT a.*, m.conversation_id FROM attachments a LEFT JOIN messages m ON m.id = a.message_id WHERE a.id = ?',
    ).get(id);
    if (!file) fail(404, '파일을 찾을 수 없어.');
    if (file.user_id !== userId && !(file.conversation_id && this.membership(userId, file.conversation_id))) {
      fail(404, '파일을 찾을 수 없어.');
    }
    return file;
  }
}
