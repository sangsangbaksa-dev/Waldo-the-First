import { join, resolve } from 'node:path';
import { openDatabase } from './db.js';
import { createChatServer } from './server.js';
import { ChatService } from './service.js';

const port = Number(process.env.PORT) || 3000;
const dataDir = resolve(process.env.DATA_DIR ?? 'data');

const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
    : null;

const config = {
  baseUrl: (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  google,
  // 구글 키가 없으면 개발용 로그인을 기본으로 켠다.
  devLogin: process.env.DEV_LOGIN ? process.env.DEV_LOGIN === 'true' : !google,
  allowedDomains: (process.env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
};

const service = new ChatService(openDatabase(join(dataDir, 'chat.db')));
const { httpServer } = createChatServer({ service, config, uploadDir: join(dataDir, 'uploads') });

httpServer.listen(port, () => {
  console.log(`채팅 서버: ${config.baseUrl}`);
  console.log(`구글 로그인: ${google ? '켜짐' : '꺼짐 (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 필요)'}`);
  if (config.devLogin) console.log('개발용 로그인: 켜짐 (운영에서는 DEV_LOGIN=false)');
});
