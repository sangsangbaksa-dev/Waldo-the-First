import { randomUUID } from 'node:crypto';

export const LIMITS = {
  name: 40,
  spaceName: 128,
  description: 150,
  message: 4000,
  statusText: 80,
  pageSize: 50,
  attachmentsPerMessage: 10,
  pinsPerConversation: 20,
  quotePreview: 200,
};

export const STATUSES = ['auto', 'away', 'dnd'];

// 메시지 본문 안의 멘션 토큰: <@사용자ID> 또는 <@all>
const MENTION = /<@([0-9a-f-]{36}|all)>/g;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 이름 끝 글자의 받침에 맞춰 '로'/'으로'를 고른다. */
export function withRo(word) {
  const digits = { 0: '으로', 1: '로', 2: '로', 3: '으로', 4: '로', 5: '로', 6: '으로', 7: '로', 8: '로', 9: '로' };
  for (const ch of [...String(word)].reverse()) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const final = (code - 0xac00) % 28;
      return final === 0 || final === 8 ? '로' : '으로';
    }
    if (ch in digits) return digits[ch];
    if (/[a-z]/i.test(ch)) return '(으)로';
  }
  return '(으)로';
}

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
  const v = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (required && !v) fail(400, `${label}을(를) 입력해 주세요.`);
  if (v.length > max) fail(400, `${label}은(는) ${max}자까지 쓸 수 있어요.`);
  return v;
}

export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) fail(400, `올바른 이메일 주소가 아니에요: ${value}`);
  return email;
}

export const validateName = (value) => text(value, LIMITS.name, '이름');

/** 프로필 사진은 Storage 경로로 저장하고, 화면에는 권한을 확인하는 /avatars/<id> 주소로 준다. */
function avatarUrl(row) {
  if (!row.avatar) return null;
  if (/^https?:\/\//.test(row.avatar)) return row.avatar;
  return `/avatars/${row.id}?v=${row.avatar.split('/').pop().slice(0, 8)}`;
}

/** 전달할 때는 멘션 토큰을 그냥 글자(@이름)로 바꿔서, 새 대화에서 다시 알림이 가지 않게 한다. */
function plainMentions(body, users) {
  return body.replace(MENTION, (_, id) => `@${id === 'all' ? 'all' : (users.get(id)?.name ?? '알 수 없음')}`);
}

function mentionedIn(body, memberIds, authorId) {
  const mentioned = new Set();
  for (const [, id] of body.matchAll(MENTION)) {
    if (id === 'all') memberIds.forEach((m) => mentioned.add(m));
    else if (memberIds.has(id)) mentioned.add(id);
  }
  mentioned.delete(authorId);
  return [...mentioned];
}

export class ChatService {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
  }

  // ───────────── 사용자 ─────────────

  publicUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      avatar: avatarUrl(row),
      registered: Boolean(row.registered),
      status: row.status,
      statusText: row.status_text,
      lastSeen: row.last_seen,
    };
  }

  async getUser(id) {
    return this.publicUser(await this.db.one('SELECT * FROM chat_users WHERE id = ?', [id]));
  }

  async usersById(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await this.db.all('SELECT * FROM chat_users WHERE id = ANY(?::text[])', [unique]);
    return new Map(rows.map((r) => [r.id, this.publicUser(r)]));
  }

  /** 아직 가입하지 않은 사람도 이메일로 초대할 수 있게 자리만 만들어 둔다. */
  async ensureUser(email, db = this.db) {
    const normalized = normalizeEmail(email);
    await db.run(
      'INSERT INTO chat_users (id, email, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING',
      [randomUUID(), normalized, normalized.split('@')[0], this.now()],
    );
    return this.publicUser(await db.one('SELECT * FROM chat_users WHERE email = ?', [normalized]));
  }

  async emailRegistered(email) {
    const row = await this.db.one('SELECT registered FROM chat_users WHERE email = ?', [normalizeEmail(email)]);
    return Boolean(row?.registered);
  }

  /**
   * Supabase Auth 계정과 채팅 프로필을 잇는다.
   * 가입 전에 초대받아 만들어진 자리가 있으면 그 자리를 이어받아서 대화가 그대로 남는다.
   */
  async linkAccount({ authId, email, name }) {
    const normalized = normalizeEmail(email);
    const byAuth = await this.db.one('SELECT * FROM chat_users WHERE auth_id = ?', [authId]);
    if (byAuth) return this.publicUser(byAuth);

    const displayName = name ? validateName(name) : normalized.split('@')[0];
    const user = await this.ensureUser(normalized);
    await this.db.run(
      'UPDATE chat_users SET auth_id = ?, name = ?, registered = TRUE, last_seen = ? WHERE id = ?',
      [authId, displayName, this.now(), user.id],
    );
    return this.getUser(user.id);
  }

  async userForAuth(authId) {
    return this.publicUser(await this.db.one('SELECT * FROM chat_users WHERE auth_id = ?', [authId]));
  }

  async authIdOf(userId) {
    return (await this.db.one('SELECT auth_id FROM chat_users WHERE id = ?', [userId]))?.auth_id ?? null;
  }

  async avatarPath(userId) {
    const row = await this.db.one('SELECT avatar FROM chat_users WHERE id = ?', [userId]);
    return row?.avatar && !/^https?:/.test(row.avatar) ? row.avatar : null;
  }

  /** 프로필 사진 경로를 바꾸고, 지워야 할 예전 파일 경로를 돌려준다. */
  async setAvatar(userId, path) {
    const old = await this.avatarPath(userId);
    await this.db.run('UPDATE chat_users SET avatar = ? WHERE id = ?', [path, userId]);
    return { user: await this.getUser(userId), oldPath: old && old !== path ? old : null };
  }

  async updateProfile(userId, { name }) {
    await this.db.run('UPDATE chat_users SET name = ? WHERE id = ?', [validateName(name), userId]);
    return this.getUser(userId);
  }

  async searchUsers(viewerId, query = '') {
    const like = `%${query.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.db.all(
      `SELECT * FROM chat_users
       WHERE id <> ? AND (lower(name) LIKE ? OR email LIKE ?)
       ORDER BY registered DESC, lower(name) LIMIT 20`,
      [viewerId, like, like],
    );
    return rows.map((row) => this.publicUser(row));
  }

  async setStatus(userId, { status, statusText }) {
    const user = await this.getUser(userId);
    const next = status ?? user.status;
    if (!STATUSES.includes(next)) fail(400, '알 수 없는 상태예요.');
    const note =
      statusText === undefined ? user.statusText : text(statusText, LIMITS.statusText, '상태 메시지', { required: false });
    await this.db.run('UPDATE chat_users SET status = ?, status_text = ? WHERE id = ?', [next, note, userId]);
    return this.getUser(userId);
  }

  async touch(userId) {
    await this.db.run('UPDATE chat_users SET last_seen = ? WHERE id = ?', [this.now(), userId]);
  }

  // ───────────── 세션 ─────────────

  async createSession(userId, ttlMs = 30 * 24 * 60 * 60 * 1000) {
    const token = randomUUID() + randomUUID();
    await this.db.run('INSERT INTO chat_sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [
      token,
      userId,
      this.now() + ttlMs,
    ]);
    return token;
  }

  async userForSession(token) {
    if (!token) return null;
    const row = await this.db.one('SELECT user_id, expires_at FROM chat_sessions WHERE token = ?', [token]);
    if (!row) return null;
    if (row.expires_at < this.now()) {
      await this.deleteSession(token);
      return null;
    }
    return this.getUser(row.user_id);
  }

  async deleteSession(token) {
    await this.db.run('DELETE FROM chat_sessions WHERE token = ?', [token]);
  }

  /** 비밀번호를 바꾸면 지금 쓰는 세션만 남기고 다른 기기에서는 로그아웃시킨다. */
  async deleteOtherSessions(userId, keepToken) {
    await this.db.run('DELETE FROM chat_sessions WHERE user_id = ? AND token <> ?', [userId, keepToken]);
  }

  // ───────────── 대화방 ─────────────

  async membership(userId, conversationId, db = this.db) {
    return db.one('SELECT * FROM chat_members WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);
  }

  async requireMember(userId, conversationId) {
    const member = await this.membership(userId, conversationId);
    if (!member) fail(404, '대화를 찾을 수 없어요.');
    return member;
  }

  async requireManager(userId, conversationId) {
    const conversation = await this.conversationRow(conversationId);
    const member = await this.requireMember(userId, conversationId);
    if (conversation.kind !== 'space') fail(400, '스페이스에서만 할 수 있어요.');
    if (member.role !== 'manager') fail(403, '스페이스 관리자만 할 수 있어요.');
    return conversation;
  }

  async conversationRow(id) {
    const row = await this.db.one('SELECT * FROM chat_conversations WHERE id = ?', [id]);
    if (!row) fail(404, '대화를 찾을 수 없어요.');
    return row;
  }

  async memberIds(conversationId) {
    const rows = await this.db.all('SELECT user_id FROM chat_members WHERE conversation_id = ?', [conversationId]);
    return rows.map((r) => r.user_id);
  }

  async members(conversationId) {
    const rows = await this.db.all(
      `SELECT u.*, m.role, m.joined_at, m.last_read_at FROM chat_members m JOIN chat_users u ON u.id = m.user_id
       WHERE m.conversation_id = ? ORDER BY m.role = 'manager' DESC, lower(u.name)`,
      [conversationId],
    );
    return rows.map((row) => ({
      ...this.publicUser(row),
      role: row.role,
      joinedAt: row.joined_at,
      lastReadAt: row.last_read_at,
    }));
  }

  async addMemberRow(db, conversationId, userId, role = 'member') {
    await db.run(
      `INSERT INTO chat_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET hidden = FALSE`,
      [conversationId, userId, role, this.now(), this.now()],
    );
  }

  async managerCount(conversationId, db = this.db) {
    const row = await db.one("SELECT COUNT(*)::int AS n FROM chat_members WHERE conversation_id = ? AND role = 'manager'", [
      conversationId,
    ]);
    return row.n;
  }

  /** 1:1 대화 또는 그룹 대화를 연다. 같은 사람들끼리의 대화가 이미 있으면 그걸 돌려준다. */
  async openDirect(userId, emails) {
    const list = [...new Set((Array.isArray(emails) ? emails : [emails]).map(normalizeEmail))];
    const others = [];
    for (const email of list) {
      const user = await this.ensureUser(email);
      if (user.id !== userId) others.push(user);
    }
    if (others.length === 0) fail(400, '대화할 사람을 한 명 이상 골라 주세요.');
    const kind = others.length === 1 ? 'dm' : 'group';
    const key = `${kind}:${[userId, ...others.map((u) => u.id)].sort().join(',')}`;

    const existing = await this.db.one('SELECT id FROM chat_conversations WHERE dm_key = ?', [key]);
    if (existing) {
      await this.db.run('UPDATE chat_members SET hidden = FALSE WHERE conversation_id = ? AND user_id = ?', [existing.id, userId]);
      return { conversation: await this.getConversation(userId, existing.id), created: false };
    }

    const id = randomUUID();
    await this.db.tx(async (db) => {
      await db.run(
        `INSERT INTO chat_conversations (id, kind, dm_key, created_by, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, kind, key, userId, this.now(), this.now()],
      );
      for (const uid of [userId, ...others.map((u) => u.id)]) await this.addMemberRow(db, id, uid);
    });
    return { conversation: await this.getConversation(userId, id), created: true };
  }

  async createSpace(userId, { name, description = '', emoji = null, visibility = 'private', memberEmails = [] }) {
    const spaceName = text(name, LIMITS.spaceName, '스페이스 이름');
    const about = text(description, LIMITS.description, '설명', { required: false });
    if (!['private', 'public'].includes(visibility)) fail(400, '공개 범위가 올바르지 않아요.');
    const emails = [...new Set((Array.isArray(memberEmails) ? memberEmails : []).map(normalizeEmail))];

    const id = randomUUID();
    await this.db.tx(async (db) => {
      await db.run(
        `INSERT INTO chat_conversations (id, kind, name, description, emoji, visibility, created_by, created_at, last_message_at)
         VALUES (?, 'space', ?, ?, ?, ?, ?, ?, ?)`,
        [id, spaceName, about, emoji || null, visibility, userId, this.now(), this.now()],
      );
      await this.addMemberRow(db, id, userId, 'manager');
      for (const email of emails) {
        const user = await this.ensureUser(email, db);
        if (user.id !== userId) await this.addMemberRow(db, id, user.id);
      }
    });
    await this.systemMessage(id, `${(await this.getUser(userId)).name}님이 스페이스를 만들었어요.`);
    return this.getConversation(userId, id);
  }

  async updateSpace(userId, conversationId, { name, description, emoji, visibility }) {
    const conversation = await this.requireManager(userId, conversationId);
    const next = {
      name: name === undefined ? conversation.name : text(name, LIMITS.spaceName, '스페이스 이름'),
      description:
        description === undefined
          ? conversation.description
          : text(description, LIMITS.description, '설명', { required: false }),
      emoji: emoji === undefined ? conversation.emoji : emoji || null,
      visibility: visibility === undefined ? conversation.visibility : visibility,
    };
    if (!['private', 'public'].includes(next.visibility)) fail(400, '공개 범위가 올바르지 않아요.');
    await this.db.run('UPDATE chat_conversations SET name = ?, description = ?, emoji = ?, visibility = ? WHERE id = ?', [
      next.name,
      next.description,
      next.emoji,
      next.visibility,
      conversationId,
    ]);
    if (next.name !== conversation.name) {
      const actor = await this.getUser(userId);
      await this.systemMessage(conversationId, `${actor.name}님이 스페이스 이름을 '${next.name}'${withRo(next.name)} 바꿨어요.`);
    }
    return this.getConversation(userId, conversationId);
  }

  async deleteSpace(userId, conversationId) {
    await this.requireManager(userId, conversationId);
    const memberIds = await this.memberIds(conversationId);
    const files = await this.db.all(
      'SELECT a.path FROM chat_attachments a JOIN chat_messages m ON m.id = a.message_id WHERE m.conversation_id = ?',
      [conversationId],
    );
    await this.db.run('DELETE FROM chat_conversations WHERE id = ?', [conversationId]);
    return { memberIds, files: files.map((f) => f.path) };
  }

  async addMembers(userId, conversationId, emails) {
    const conversation = await this.conversationRow(conversationId);
    await this.requireMember(userId, conversationId);
    if (conversation.kind === 'dm') fail(400, '1:1 대화에는 사람을 추가할 수 없어요. 새 그룹 대화를 만들어 주세요.');
    const actor = await this.getUser(userId);
    const added = [];
    for (const email of [...new Set((Array.isArray(emails) ? emails : []).map(normalizeEmail))]) {
      const user = await this.ensureUser(email);
      if (await this.membership(user.id, conversationId)) continue;
      await this.addMemberRow(this.db, conversationId, user.id);
      added.push(user);
    }
    if (added.length) {
      // 그룹 대화에 사람이 늘면 더 이상 "이 사람들끼리의 대화"가 아니다.
      if (conversation.kind === 'group') {
        await this.db.run('UPDATE chat_conversations SET dm_key = NULL WHERE id = ?', [conversationId]);
      }
      await this.systemMessage(conversationId, `${actor.name}님이 ${added.map((u) => u.name).join(', ')}님을 추가했어요.`);
    }
    return added;
  }

  async joinSpace(userId, conversationId) {
    const conversation = await this.conversationRow(conversationId);
    if (conversation.kind !== 'space' || conversation.visibility !== 'public') fail(404, '대화를 찾을 수 없어요.');
    if (!(await this.membership(userId, conversationId))) {
      await this.addMemberRow(this.db, conversationId, userId);
      await this.systemMessage(conversationId, `${(await this.getUser(userId)).name}님이 참여했어요.`);
    }
    return this.getConversation(userId, conversationId);
  }

  /** 다른 사람을 내보내거나(관리자) 스스로 나간다. */
  async removeMember(userId, conversationId, targetId) {
    const conversation = await this.conversationRow(conversationId);
    const self = userId === targetId;
    if (conversation.kind === 'dm') fail(400, '1:1 대화는 나갈 수 없어요. 대신 대화 숨기기를 사용해 주세요.');
    if (self) await this.requireMember(userId, conversationId);
    else if (conversation.kind === 'space') await this.requireManager(userId, conversationId);
    else fail(403, '그룹 대화에서는 본인만 나갈 수 있어요.');

    const target = await this.membership(targetId, conversationId);
    if (!target) fail(404, '그 사람은 이 대화에 없어요.');

    await this.db.tx(async (db) => {
      await db.run('DELETE FROM chat_members WHERE conversation_id = ? AND user_id = ?', [conversationId, targetId]);
      // 마지막 관리자가 나가면 가장 오래된 멤버를 관리자로 올린다.
      if (conversation.kind === 'space' && target.role === 'manager' && (await this.managerCount(conversationId, db)) === 0) {
        await db.run(
          `UPDATE chat_members SET role = 'manager' WHERE conversation_id = ? AND user_id =
           (SELECT user_id FROM chat_members WHERE conversation_id = ? ORDER BY joined_at LIMIT 1)`,
          [conversationId, conversationId],
        );
      }
      if (conversation.kind === 'group') {
        await db.run('UPDATE chat_conversations SET dm_key = NULL WHERE id = ?', [conversationId]);
      }
    });

    const name = (await this.getUser(targetId)).name;
    const actor = (await this.getUser(userId)).name;
    await this.systemMessage(conversationId, self ? `${name}님이 나갔어요.` : `${actor}님이 ${name}님을 내보냈어요.`);
  }

  async setRole(userId, conversationId, targetId, role) {
    await this.requireManager(userId, conversationId);
    if (!['manager', 'member'].includes(role)) fail(400, '알 수 없는 역할이에요.');
    const target = await this.membership(targetId, conversationId);
    if (!target) fail(404, '그 사람은 이 대화에 없어요.');
    if (role === 'member' && target.role === 'manager' && (await this.managerCount(conversationId)) <= 1) {
      fail(400, '스페이스에는 관리자가 한 명 이상 있어야 해요.');
    }
    await this.db.run('UPDATE chat_members SET role = ? WHERE conversation_id = ? AND user_id = ?', [
      role,
      conversationId,
      targetId,
    ]);
  }

  async setPreferences(userId, conversationId, { muted, pinned, hidden }) {
    const member = await this.requireMember(userId, conversationId);
    const flag = (value, current) => (value === undefined ? current : Boolean(value));
    await this.db.run('UPDATE chat_members SET muted = ?, pinned = ?, hidden = ? WHERE conversation_id = ? AND user_id = ?', [
      flag(muted, member.muted),
      flag(pinned, member.pinned),
      flag(hidden, member.hidden),
      conversationId,
      userId,
    ]);
    return this.getConversation(userId, conversationId);
  }

  async markRead(userId, conversationId) {
    await this.requireMember(userId, conversationId);
    const at = this.now();
    await this.db.run('UPDATE chat_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', [
      at,
      conversationId,
      userId,
    ]);
    return at;
  }

  async listPublicSpaces(userId, query = '') {
    const like = `%${query.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.db.all(
      `SELECT c.*, (SELECT COUNT(*)::int FROM chat_members WHERE conversation_id = c.id) AS member_count
       FROM chat_conversations c
       WHERE c.kind = 'space' AND c.visibility = 'public' AND lower(c.name) LIKE ?
         AND NOT EXISTS (SELECT 1 FROM chat_members WHERE conversation_id = c.id AND user_id = ?)
       ORDER BY c.last_message_at DESC LIMIT 50`,
      [like, userId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      emoji: row.emoji,
      memberCount: row.member_count,
    }));
  }

  async summarize(userId, row) {
    const members = await this.members(row.id);
    const others = members.filter((m) => m.id !== userId);
    const counts = await this.db.one(
      `SELECT
         (SELECT COUNT(*)::int FROM chat_messages
          WHERE conversation_id = ? AND thread_id IS NULL AND kind = 'user' AND NOT deleted
            AND created_at > ? AND user_id <> ?) AS unread,
         (SELECT COUNT(*)::int FROM chat_mentions x JOIN chat_messages m ON m.id = x.message_id
          WHERE m.conversation_id = ? AND x.user_id = ? AND m.created_at > ? AND NOT m.deleted) AS mentions,
         (SELECT COUNT(*)::int FROM chat_pins WHERE conversation_id = ?) AS pins`,
      [row.id, row.last_read_at, userId, row.id, userId, row.last_read_at, row.id],
    );
    const last = await this.db.one(
      `SELECT m.id, m.body, m.kind, m.deleted, u.name FROM chat_messages m LEFT JOIN chat_users u ON u.id = m.user_id
       WHERE m.conversation_id = ? AND m.thread_id IS NULL ORDER BY m.created_at DESC LIMIT 1`,
      [row.id],
    );

    const name = row.kind === 'space' ? row.name : others.map((m) => m.name).join(', ') || '나';
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
      unread: counts.unread,
      mentionCount: counts.mentions,
      pinnedCount: counts.pins,
      members,
      lastMessage: last
        ? { id: last.id, author: last.name, body: last.deleted ? '' : last.body, kind: last.kind, deleted: Boolean(last.deleted) }
        : null,
    };
  }

  async listConversations(userId) {
    const rows = await this.db.all(
      `SELECT c.*, m.role, m.muted, m.pinned, m.hidden, m.last_read_at
       FROM chat_conversations c JOIN chat_members m ON m.conversation_id = c.id
       WHERE m.user_id = ? ORDER BY m.pinned DESC, c.last_message_at DESC`,
      [userId],
    );
    return Promise.all(rows.map((row) => this.summarize(userId, row)));
  }

  async getConversation(userId, conversationId) {
    await this.requireMember(userId, conversationId);
    const row = await this.db.one(
      `SELECT c.*, m.role, m.muted, m.pinned, m.hidden, m.last_read_at
       FROM chat_conversations c JOIN chat_members m ON m.conversation_id = c.id
       WHERE c.id = ? AND m.user_id = ?`,
      [conversationId, userId],
    );
    return this.summarize(userId, row);
  }

  // ───────────── 메시지 ─────────────

  async systemMessage(conversationId, body) {
    const id = randomUUID();
    const at = this.now();
    await this.db.tx(async (db) => {
      await db.run("INSERT INTO chat_messages (id, conversation_id, kind, body, created_at) VALUES (?, ?, 'system', ?, ?)", [
        id,
        conversationId,
        body,
        at,
      ]);
      await db.run('UPDATE chat_conversations SET last_message_at = ? WHERE id = ?', [at, conversationId]);
    });
    return id;
  }

  async messageRow(messageId) {
    const row = await this.db.one('SELECT * FROM chat_messages WHERE id = ?', [messageId]);
    if (!row) fail(404, '메시지를 찾을 수 없어요.');
    return row;
  }

  /** 메시지 여러 개를 화면에 쓸 모양으로 바꾼다. 반응, 첨부, 답글 수 등을 한 번에 붙인다. */
  async hydrate(viewerId, rows) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const quoteIds = [...new Set(rows.map((r) => r.quote_id).filter(Boolean))];
    const [reactionRows, attachmentRows, replyRows, starRows, quoteRows, pinRows] = await Promise.all([
      this.db.all(
        'SELECT message_id, emoji, user_id FROM chat_reactions WHERE message_id = ANY(?::text[]) ORDER BY created_at',
        [ids],
      ),
      this.db.all(
        `SELECT id, message_id, filename, mime, size FROM chat_attachments
         WHERE message_id = ANY(?::text[]) ORDER BY created_at`,
        [ids],
      ),
      this.db.all(
        `SELECT thread_id, COUNT(*)::int AS n, MAX(created_at) AS last, array_agg(DISTINCT user_id) AS people
         FROM chat_messages WHERE thread_id = ANY(?::text[]) AND NOT deleted GROUP BY thread_id`,
        [ids],
      ),
      this.db.all('SELECT message_id FROM chat_stars WHERE user_id = ? AND message_id = ANY(?::text[])', [viewerId, ids]),
      quoteIds.length
        ? this.db.all(
            `SELECT m.id, m.user_id, m.body, m.deleted, m.created_at,
                    (SELECT COUNT(*)::int FROM chat_attachments a WHERE a.message_id = m.id) AS files
             FROM chat_messages m WHERE m.id = ANY(?::text[])`,
            [quoteIds],
          )
        : [],
      this.db.all('SELECT message_id FROM chat_pins WHERE message_id = ANY(?::text[])', [ids]),
    ]);

    const mentionIds = rows.flatMap((r) => (r.deleted ? [] : [...r.body.matchAll(MENTION)].map((m) => m[1])));
    const users = await this.usersById([
      ...rows.map((r) => r.user_id),
      ...reactionRows.map((r) => r.user_id),
      ...replyRows.flatMap((r) => r.people ?? []),
      ...mentionIds.filter((id) => id !== 'all'),
      ...quoteRows.map((q) => q.user_id),
      ...quoteRows.flatMap((q) => [...q.body.matchAll(MENTION)].map((m) => m[1])).filter((id) => id !== 'all'),
    ]);
    const quotes = new Map(
      quoteRows.map((q) => [
        q.id,
        {
          id: q.id,
          author: users.get(q.user_id)?.name ?? '알 수 없음',
          body: q.deleted ? '' : plainMentions(q.body, users).slice(0, LIMITS.quotePreview),
          deleted: Boolean(q.deleted),
          files: q.deleted ? 0 : q.files,
          createdAt: q.created_at,
        },
      ]),
    );
    const pinned = new Set(pinRows.map((r) => r.message_id));

    const reactions = new Map();
    for (const r of reactionRows) {
      const byEmoji = reactions.get(r.message_id) ?? new Map();
      const entry = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, users: [], userIds: [], mine: false };
      entry.count += 1;
      entry.users.push(users.get(r.user_id)?.name);
      entry.userIds.push(r.user_id);
      if (r.user_id === viewerId) entry.mine = true;
      byEmoji.set(r.emoji, entry);
      reactions.set(r.message_id, byEmoji);
    }

    const attachments = new Map();
    for (const a of attachmentRows) {
      const list = attachments.get(a.message_id) ?? [];
      list.push({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: `/files/${a.id}` });
      attachments.set(a.message_id, list);
    }

    const replies = new Map(
      replyRows.map((r) => [
        r.thread_id,
        {
          count: r.n,
          lastAt: r.last,
          people: (r.people ?? []).filter(Boolean).slice(0, 3).map((id) => users.get(id)),
        },
      ]),
    );
    const starred = new Set(starRows.map((r) => r.message_id));

    return rows.map((row) => {
      const mentions = {};
      if (!row.deleted) {
        for (const [, id] of row.body.matchAll(MENTION)) {
          mentions[id] = id === 'all' ? 'all' : (users.get(id)?.name ?? '알 수 없음');
        }
      }
      return {
        id: row.id,
        conversationId: row.conversation_id,
        threadId: row.thread_id,
        kind: row.kind,
        author: users.get(row.user_id) ?? null,
        body: row.deleted ? '' : row.body,
        mentions,
        createdAt: row.created_at,
        editedAt: row.edited_at,
        deleted: Boolean(row.deleted),
        reactions: [...(reactions.get(row.id)?.values() ?? [])],
        attachments: row.deleted ? [] : (attachments.get(row.id) ?? []),
        replies: replies.get(row.id) ?? { count: 0, lastAt: null, people: [] },
        starred: starred.has(row.id),
        pinned: pinned.has(row.id),
        quote: row.quote_id ? (quotes.get(row.quote_id) ?? null) : null,
        forwardedFrom: row.forwarded_from ?? null,
      };
    });
  }

  async getMessage(viewerId, messageId) {
    const row = await this.messageRow(messageId);
    await this.requireMember(viewerId, row.conversation_id);
    return (await this.hydrate(viewerId, [row]))[0];
  }

  async listMessages(userId, conversationId, { before, threadId } = {}) {
    await this.requireMember(userId, conversationId);
    if (threadId) {
      const root = await this.messageRow(threadId);
      if (root.conversation_id !== conversationId) fail(404, '스레드를 찾을 수 없어요.');
      const replies = await this.db.all('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at', [threadId]);
      return { messages: await this.hydrate(userId, [root, ...replies]), hasMore: false };
    }
    const rows = await this.db.all(
      `SELECT * FROM chat_messages WHERE conversation_id = ? AND thread_id IS NULL AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`,
      [conversationId, Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER, LIMITS.pageSize + 1],
    );
    const hasMore = rows.length > LIMITS.pageSize;
    return { messages: await this.hydrate(userId, rows.slice(0, LIMITS.pageSize).reverse()), hasMore };
  }

  /**
   * 메시지를 보낸다. 본문의 <@id>, <@all> 토큰으로 멘션을 기록한다.
   * 돌려주는 값에 멘션된 사람 목록을 함께 실어 알림에 쓴다.
   */
  async sendMessage(userId, conversationId, { body = '', threadId = null, attachmentIds = [], quoteId = null }, { forwardedFrom = null } = {}) {
    await this.requireMember(userId, conversationId);
    const content = typeof body === 'string' ? body.trim() : '';
    if (content.length > LIMITS.message) fail(400, `메시지는 ${LIMITS.message}자까지 쓸 수 있어요.`);
    const ids = [...new Set(Array.isArray(attachmentIds) ? attachmentIds : [])];
    if (ids.length > LIMITS.attachmentsPerMessage) fail(400, `파일은 한 번에 ${LIMITS.attachmentsPerMessage}개까지 보낼 수 있어요.`);
    if (!content && ids.length === 0) fail(400, '빈 메시지는 보낼 수 없어요.');

    if (threadId) {
      const root = await this.messageRow(threadId);
      if (root.conversation_id !== conversationId || root.thread_id) fail(400, '답장할 수 없는 메시지예요.');
    }

    if (quoteId) {
      const quoted = await this.db.one('SELECT conversation_id, kind, deleted FROM chat_messages WHERE id = ?', [quoteId]);
      if (!quoted || quoted.conversation_id !== conversationId || quoted.kind !== 'user' || quoted.deleted) {
        fail(400, '인용할 수 없는 메시지예요.');
      }
    }

    if (ids.length) {
      const files = await this.db.all('SELECT * FROM chat_attachments WHERE id = ANY(?::text[])', [ids]);
      const usable = files.filter((f) => f.user_id === userId && !f.message_id);
      if (usable.length !== ids.length) fail(400, '첨부 파일을 찾을 수 없어요.');
    }

    const mentioned = mentionedIn(content, new Set(await this.memberIds(conversationId)), userId);
    const id = randomUUID();
    const at = this.now();
    await this.db.tx(async (db) => {
      await db.run(
        `INSERT INTO chat_messages (id, conversation_id, user_id, thread_id, body, created_at, quote_id, forwarded_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, conversationId, userId, threadId, content, at, quoteId || null, forwardedFrom],
      );
      if (ids.length) {
        // 다른 요청이 같은 첨부를 먼저 가져갔으면 여기서 막힌다.
        const claimed = await db.all(
          'UPDATE chat_attachments SET message_id = ? WHERE id = ANY(?::text[]) AND user_id = ? AND message_id IS NULL RETURNING id',
          [id, ids, userId],
        );
        if (claimed.length !== ids.length) fail(400, '첨부 파일을 찾을 수 없어요.');
      }
      for (const uid of mentioned) await db.run('INSERT INTO chat_mentions (message_id, user_id) VALUES (?, ?)', [id, uid]);
      await db.run('UPDATE chat_conversations SET last_message_at = ? WHERE id = ?', [at, conversationId]);
      // 보낸 사람은 자기 메시지를 읽은 것으로, 숨겨 둔 사람에게는 다시 보이게.
      await db.run('UPDATE chat_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', [
        at,
        conversationId,
        userId,
      ]);
      await db.run('UPDATE chat_members SET hidden = FALSE WHERE conversation_id = ? AND hidden', [conversationId]);
    });

    return { message: await this.getMessage(userId, id), mentioned };
  }

  async editMessage(userId, messageId, body) {
    const row = await this.messageRow(messageId);
    await this.requireMember(userId, row.conversation_id);
    if (row.user_id !== userId || row.kind !== 'user') fail(403, '내가 보낸 메시지만 수정할 수 있어요.');
    if (row.deleted) fail(400, '삭제된 메시지예요.');
    const content = typeof body === 'string' ? body.trim() : '';
    if (!content) fail(400, '내용을 모두 지울 수는 없어요. 지우려면 삭제를 사용해 주세요.');
    if (content.length > LIMITS.message) fail(400, `메시지는 ${LIMITS.message}자까지 쓸 수 있어요.`);

    const mentioned = mentionedIn(content, new Set(await this.memberIds(row.conversation_id)), userId);
    await this.db.tx(async (db) => {
      await db.run('UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?', [content, this.now(), messageId]);
      await db.run('DELETE FROM chat_mentions WHERE message_id = ?', [messageId]);
      for (const uid of mentioned) {
        await db.run('INSERT INTO chat_mentions (message_id, user_id) VALUES (?, ?)', [messageId, uid]);
      }
    });
    return this.getMessage(userId, messageId);
  }

  async deleteMessage(userId, messageId) {
    const row = await this.messageRow(messageId);
    const member = await this.requireMember(userId, row.conversation_id);
    const conversation = await this.conversationRow(row.conversation_id);
    const canModerate = conversation.kind === 'space' && member.role === 'manager';
    if (row.kind !== 'user' || (row.user_id !== userId && !canModerate)) fail(403, '이 메시지는 삭제할 수 없어요.');
    const files = (await this.db.all('SELECT path FROM chat_attachments WHERE message_id = ?', [messageId])).map((f) => f.path);
    await this.db.tx(async (db) => {
      await db.run("UPDATE chat_messages SET deleted = TRUE, body = '' WHERE id = ?", [messageId]);
      for (const table of ['chat_attachments', 'chat_reactions', 'chat_mentions', 'chat_stars', 'chat_pins']) {
        await db.run(`DELETE FROM ${table} WHERE message_id = ?`, [messageId]);
      }
    });
    return { message: await this.getMessage(userId, messageId), files };
  }

  /**
   * 다른 대화로 전달할 준비: 권한을 확인하고, 새 메시지에 쓸 본문과 복사할 첨부 목록을 돌려준다.
   * (첨부는 Storage에서 복사해야 해서 실제 보내기는 서버 라우트가 마무리한다.)
   */
  async prepareForward(userId, messageId, targetConversationId) {
    const row = await this.messageRow(messageId);
    await this.requireMember(userId, row.conversation_id);
    await this.requireMember(userId, targetConversationId);
    if (row.kind !== 'user' || row.deleted) fail(400, '전달할 수 없는 메시지예요.');
    const users = await this.usersById([row.user_id, ...[...row.body.matchAll(MENTION)].map((m) => m[1])]);
    const files = await this.db.all(
      'SELECT filename, mime, size, path FROM chat_attachments WHERE message_id = ? ORDER BY created_at',
      [messageId],
    );
    return {
      body: plainMentions(row.body, users),
      files,
      forwardedFrom: row.forwarded_from ?? users.get(row.user_id)?.name ?? '알 수 없음',
    };
  }

  /** 메시지 고정/해제. 대화 멤버라면 누구나 할 수 있다. */
  async togglePin(userId, messageId) {
    const row = await this.messageRow(messageId);
    await this.requireMember(userId, row.conversation_id);
    if (row.kind !== 'user' || row.deleted) fail(400, '고정할 수 없는 메시지예요.');
    const removed = await this.db.all('DELETE FROM chat_pins WHERE message_id = ? RETURNING message_id', [messageId]);
    if (!removed.length) {
      const { n } = await this.db.one('SELECT COUNT(*)::int AS n FROM chat_pins WHERE conversation_id = ?', [row.conversation_id]);
      if (n >= LIMITS.pinsPerConversation) fail(400, `메시지는 대화마다 ${LIMITS.pinsPerConversation}개까지 고정할 수 있어요.`);
      await this.db.run(
        'INSERT INTO chat_pins (conversation_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [row.conversation_id, messageId, userId, this.now()],
      );
    }
    return this.getMessage(userId, messageId);
  }

  async listPins(userId, conversationId) {
    await this.requireMember(userId, conversationId);
    const rows = await this.db.all(
      `SELECT m.*, p.pinned_at, p.pinned_by FROM chat_pins p JOIN chat_messages m ON m.id = p.message_id
       WHERE p.conversation_id = ? ORDER BY p.pinned_at DESC`,
      [conversationId],
    );
    const pinners = await this.usersById(rows.map((r) => r.pinned_by));
    const messages = await this.hydrate(userId, rows);
    return messages.map((m, i) => ({ ...m, pinnedAt: rows[i].pinned_at, pinnedBy: pinners.get(rows[i].pinned_by)?.name ?? null }));
  }

  async toggleReaction(userId, messageId, emoji) {
    const row = await this.messageRow(messageId);
    await this.requireMember(userId, row.conversation_id);
    if (row.deleted || row.kind !== 'user') fail(400, '이 메시지에는 반응할 수 없어요.');
    const value = typeof emoji === 'string' ? emoji.trim() : '';
    if (!value || value.length > 16) fail(400, '이모티콘이 올바르지 않아요.');
    const removed = await this.db.all(
      'DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ? RETURNING emoji',
      [messageId, userId, value],
    );
    if (!removed.length) {
      await this.db.run(
        'INSERT INTO chat_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [messageId, userId, value, this.now()],
      );
    }
    return this.getMessage(userId, messageId);
  }

  async toggleStar(userId, messageId) {
    const row = await this.messageRow(messageId);
    await this.requireMember(userId, row.conversation_id);
    if (row.deleted || row.kind !== 'user') fail(400, '이 메시지는 별표표시할 수 없어요.');
    const removed = await this.db.all('DELETE FROM chat_stars WHERE message_id = ? AND user_id = ? RETURNING message_id', [
      messageId,
      userId,
    ]);
    if (!removed.length) {
      await this.db.run('INSERT INTO chat_stars (message_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [
        messageId,
        userId,
        this.now(),
      ]);
    }
    return this.getMessage(userId, messageId);
  }

  async listStarred(userId) {
    const rows = await this.db.all(
      `SELECT m.* FROM chat_stars s
       JOIN chat_messages m ON m.id = s.message_id
       JOIN chat_members mb ON mb.conversation_id = m.conversation_id AND mb.user_id = s.user_id
       WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 100`,
      [userId],
    );
    return this.hydrate(userId, rows);
  }

  async listMentions(userId) {
    const rows = await this.db.all(
      `SELECT m.* FROM chat_mentions x
       JOIN chat_messages m ON m.id = x.message_id
       JOIN chat_members mb ON mb.conversation_id = m.conversation_id AND mb.user_id = x.user_id
       WHERE x.user_id = ? AND NOT m.deleted ORDER BY m.created_at DESC LIMIT 100`,
      [userId],
    );
    return this.hydrate(userId, rows);
  }

  async search(userId, query, { conversationId } = {}) {
    const term = typeof query === 'string' ? query.trim() : '';
    if (!term) return [];
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.db.all(
      `SELECT m.* FROM chat_messages m
       JOIN chat_members mb ON mb.conversation_id = m.conversation_id AND mb.user_id = ?
       WHERE m.kind = 'user' AND NOT m.deleted AND m.body ILIKE ?
         AND (?::text IS NULL OR m.conversation_id = ?::text)
       ORDER BY m.created_at DESC LIMIT 50`,
      [userId, like, conversationId ?? null, conversationId ?? null],
    );
    return this.hydrate(userId, rows);
  }

  // ───────────── 첨부 파일 ─────────────

  async createAttachment(userId, { id = randomUUID(), filename, mime, size, path }) {
    await this.db.run(
      'INSERT INTO chat_attachments (id, user_id, filename, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, userId, filename, mime, size, path, this.now()],
    );
    return { id, filename, mime, size, url: `/files/${id}` };
  }

  /** 아직 메시지에 붙지 않은 내 첨부 파일들의 Storage 경로. 보내기 전에 업로드가 끝났는지 확인할 때 쓴다. */
  async pendingAttachmentPaths(userId, ids) {
    const list = [...new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [])];
    if (!list.length) return [];
    const rows = await this.db.all(
      'SELECT path FROM chat_attachments WHERE id = ANY(?::text[]) AND user_id = ? AND message_id IS NULL',
      [list, userId],
    );
    return rows.map((r) => r.path);
  }

  /** 올린 사람이거나, 파일이 올라간 대화의 멤버여야 받을 수 있다. */
  async attachmentFor(userId, id) {
    const file = await this.db.one(
      `SELECT a.*, m.conversation_id FROM chat_attachments a
       LEFT JOIN chat_messages m ON m.id = a.message_id WHERE a.id = ?`,
      [id],
    );
    if (!file) fail(404, '파일을 찾을 수 없어요.');
    if (file.user_id !== userId && !(file.conversation_id && (await this.membership(userId, file.conversation_id)))) {
      fail(404, '파일을 찾을 수 없어요.');
    }
    return file;
  }
}
