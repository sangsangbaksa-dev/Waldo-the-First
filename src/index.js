import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createDb, pgAdapter } from './db.js';
import { createChatServer, MAX_UPLOAD } from './server.js';
import { ChatService } from './service.js';
import { SupabaseGateway } from './supabase.js';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`환경 변수 ${name}이(가) 없어. .env.example을 보고 .env를 채워 줘.`);
    process.exit(1);
  }
  return value;
}

const port = Number(process.env.PORT) || 3000;
const baseUrl = (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, '');

const config = {
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY || false,
  allowedDomains: (process.env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
};

// Postgres의 BIGINT(밀리초 시각)를 문자열이 아닌 숫자로 받는다.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

// Supabase는 SSL 연결이 필요하다. 인증서까지 확인하려면 대시보드에서 받은 CA 인증서 경로를 DATABASE_CA_CERT에 넣는다.
let ssl;
if (process.env.DATABASE_SSL === 'disable') ssl = false;
else if (process.env.DATABASE_CA_CERT) ssl = { ca: readFileSync(process.env.DATABASE_CA_CERT, 'utf8'), rejectUnauthorized: true };
else ssl = { rejectUnauthorized: false };

const pool = new pg.Pool({ connectionString: required('DATABASE_URL'), ssl, max: Number(process.env.DATABASE_POOL_SIZE) || 10 });
pool.on('error', (error) => console.error('DB 연결 오류:', error.message));

const db = createDb(pgAdapter(pool));
const supabase = new SupabaseGateway({
  url: required('SUPABASE_URL'),
  serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  anonKey: required('SUPABASE_ANON_KEY'),
  bucket: process.env.SUPABASE_BUCKET || 'chat-attachments',
});

await db.migrate();
await supabase.ensureBucket(MAX_UPLOAD);

const service = new ChatService(db);
const { httpServer } = createChatServer({ service, supabase, config });

httpServer.listen(port, () => {
  console.log(`채팅 서버: ${baseUrl}`);
  if (ssl && !ssl.rejectUnauthorized) console.log('DB: SSL로 연결 (인증서 확인은 DATABASE_CA_CERT를 넣으면 켜져)');
});
