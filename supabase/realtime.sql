-- 실시간 채널 권한. Supabase SQL Editor에서 한 번만 실행하면 돼(서버가 자동으로 실행하지 않아).
-- realtime.messages 규칙을 바꾸면 실시간 서비스가 잡고 있는 잠금을 기다릴 수 있어서, 매번 켤 때 돌리지 않는다.
--
-- - 각자 자기 채널(user:<채팅 사용자 ID>)만 받을 수 있다.
-- - chat:everyone 채널은 로그인한 사람이면 받을 수 있고, 접속 상태(presence)만 보낼 수 있다.
-- - 서버는 service_role 키로 보내므로 이 규칙을 거치지 않는다.

CREATE SCHEMA IF NOT EXISTS chat_private;
REVOKE ALL ON SCHEMA chat_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA chat_private TO authenticated;

-- chat_users는 RLS로 막혀 있어서 규칙 안에서 직접 못 읽는다. 내 채팅 ID만 돌려주는 함수를 쓴다.
CREATE OR REPLACE FUNCTION chat_private.my_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id FROM public.chat_users u WHERE u.auth_id = (SELECT auth.uid())::text
$$;
REVOKE ALL ON FUNCTION chat_private.my_user_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat_private.my_user_id() TO authenticated;

DROP POLICY IF EXISTS "waldo_chat_receive" ON realtime.messages;
CREATE POLICY "waldo_chat_receive" ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.topic() = 'chat:everyone'
    OR realtime.topic() = 'user:' || (SELECT chat_private.my_user_id())
  );

DROP POLICY IF EXISTS "waldo_chat_presence" ON realtime.messages;
CREATE POLICY "waldo_chat_presence" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    realtime.topic() = 'chat:everyone'
    AND realtime.messages.extension = 'presence'
  );
