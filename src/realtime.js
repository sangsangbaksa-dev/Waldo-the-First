/**
 * Supabase Realtime으로 실시간 이벤트를 보낸다.
 * 서버(서버리스 함수 포함)는 웹소켓을 붙잡고 있을 필요 없이 REST로 방송하고,
 * 브라우저는 자기 비공개 채널(user:<채팅 사용자 ID>)을 구독해서 받는다.
 * 누가 어떤 채널을 받을 수 있는지는 supabase/realtime.sql의 RLS 규칙이 정한다.
 */
export const EVERYONE = 'chat:everyone';
export const userTopic = (userId) => `user:${userId}`;

const BATCH = 100;

export class RealtimeGateway {
  constructor({ url, serviceRoleKey, fetchImpl = fetch }) {
    this.endpoint = `${url.replace(/\/$/, '')}/realtime/v1/api/broadcast`;
    this.key = serviceRoleKey;
    this.fetch = fetchImpl;
  }

  /** messages: [{ topic, event, payload }] — 모두 비공개 채널로 보낸다. */
  async broadcast(messages) {
    for (let i = 0; i < messages.length; i += BATCH) {
      const batch = messages.slice(i, i + BATCH).map((m) => ({ ...m, private: true }));
      const res = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: batch }),
      });
      if (!res.ok) throw new Error(`Realtime 방송 실패: ${res.status} ${await res.text().catch(() => '')}`);
    }
  }

  toUsers(userIds, event, payload) {
    const ids = [...new Set(userIds)];
    return this.broadcast(ids.map((id) => ({ topic: userTopic(id), event, payload })));
  }

  toEveryone(event, payload) {
    return this.broadcast([{ topic: EVERYONE, event, payload }]);
  }
}
