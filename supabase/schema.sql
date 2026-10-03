-- Waldo Chat 테이블. 서버가 켜질 때 자동으로 실행되고, Supabase SQL Editor에 붙여 넣어 직접 실행해도 돼.
-- 여러 번 실행해도 안전해(IF NOT EXISTS).
--
-- 모든 테이블에 RLS를 켜고 정책은 만들지 않는다. 그래서 브라우저에 공개되는 anon 키로는
-- Supabase REST API를 통해 이 테이블들을 읽거나 쓸 수 없고, 우리 서버(DB 직접 연결)만 접근한다.

CREATE TABLE IF NOT EXISTS chat_users (
  id          TEXT PRIMARY KEY,
  auth_id     TEXT UNIQUE,              -- Supabase Auth의 사용자 ID (가입 전 초대만 받은 사람은 NULL)
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  avatar      TEXT,
  registered  BOOLEAN NOT NULL DEFAULT FALSE,
  status      TEXT NOT NULL DEFAULT 'auto' CHECK (status IN ('auto', 'away', 'dnd')),
  status_text TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  last_seen   BIGINT
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_sessions_by_user ON chat_sessions(user_id);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'space')),
  name            TEXT,
  description     TEXT NOT NULL DEFAULT '',
  emoji           TEXT,
  visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  dm_key          TEXT UNIQUE,
  created_by      TEXT REFERENCES chat_users(id) ON DELETE SET NULL,
  created_at      BIGINT NOT NULL,
  last_message_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('manager', 'member')),
  joined_at       BIGINT NOT NULL,
  last_read_at    BIGINT NOT NULL DEFAULT 0,
  muted           BOOLEAN NOT NULL DEFAULT FALSE,
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  hidden          BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_by_user ON chat_members(user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES chat_users(id) ON DELETE SET NULL,
  thread_id       TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'system')),
  body            TEXT NOT NULL DEFAULT '',
  created_at      BIGINT NOT NULL,
  edited_at       BIGINT,
  deleted         BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS chat_messages_by_conversation ON chat_messages(conversation_id, thread_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_by_thread ON chat_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS chat_mentions (
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_mentions_by_user ON chat_mentions(user_id);

CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS chat_stars (
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- path는 Supabase Storage 버킷 안의 경로
CREATE TABLE IF NOT EXISTS chat_attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       BIGINT NOT NULL,
  path       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_attachments_by_message ON chat_attachments(message_id);

ALTER TABLE chat_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_stars ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments ENABLE ROW LEVEL SECURITY;

-- ── 2차: 인용 답장, 전달, 메시지 고정 ─────────────────────
-- 인용한 원래 메시지 (원래 메시지가 지워져도 인용 표시는 "삭제된 메시지"로 남는다)
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS quote_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL;
-- 다른 대화에서 전달된 메시지라면 원래 보낸 사람 이름
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS forwarded_from TEXT;

CREATE TABLE IF NOT EXISTS chat_pins (
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  pinned_by       TEXT REFERENCES chat_users(id) ON DELETE SET NULL,
  pinned_at       BIGINT NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);
ALTER TABLE chat_pins ENABLE ROW LEVEL SECURITY;
