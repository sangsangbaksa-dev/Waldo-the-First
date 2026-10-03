import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { databaseOptions, explainDbError } from './database-config.js';
import { createDb, pgAdapter } from './db.js';
import { createChatServer, MAX_UPLOAD } from './server.js';
import { ChatService } from './service.js';
import { SupabaseGateway } from './supabase.js';

// .env를 읽는다. Node의 --env-file은 컴퓨터에 이미 같은 이름의 환경 변수가 있으면 .env 값을 무시해서,
// 예전에 다른 프로그램이 넣어 둔 DATABASE_URL 같은 값 때문에 헷갈리는 일이 생긴다. 여기서는 .env가 이긴다.
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '')))) {
    if (process.env[key] && process.env[key] !== value) {
      console.warn(`알림: 컴퓨터에 이미 ${key} 환경 변수가 있어서 .env 값으로 바꿔 썼어.`);
    }
    process.env[key] = value;
  }
}

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

const database = databaseOptions(process.env);
if (database.error) {
  console.error(`DB 설정 문제: ${database.error}`);
  process.exit(1);
}
const pool = new pg.Pool({
  ...database.options,
  ssl,
  max: Number(process.env.DATABASE_POOL_SIZE) || 10,
  connectionTimeoutMillis: 15000, // 연결이 막혀 있으면 멈춰 있지 말고 15초 뒤 알려 준다
});
pool.on('error', (error) => console.error('DB 연결 오류:', error.message));

const db = createDb(pgAdapter(pool));
const supabase = new SupabaseGateway({
  url: required('SUPABASE_URL'),
  serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  anonKey: required('SUPABASE_ANON_KEY'),
  bucket: process.env.SUPABASE_BUCKET || 'chat-attachments',
});

try {
  await db.migrate();
} catch (error) {
  const hint = explainDbError(error);
  console.error(hint ? `DB에 연결하지 못했어: ${hint}` : error);
  if (hint) console.error(`  (원래 메시지: ${error.message})`);
  process.exit(1);
}
try {
  await supabase.ensureBucket(MAX_UPLOAD);
} catch (error) {
  console.error(`Supabase에 연결하지 못했어: ${error.message}`);
  console.error('  SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY가 맞는지 확인해 (service_role 키 자리에 anon 키를 넣지 않았는지도).');
  process.exit(1);
}

const service = new ChatService(db);
const { httpServer } = createChatServer({ service, supabase, config });

httpServer.listen(port, () => {
  console.log(`채팅 서버: ${baseUrl}`);
  if (ssl && !ssl.rejectUnauthorized) console.log('DB: SSL로 연결 (인증서 확인은 DATABASE_CA_CERT를 넣으면 켜져)');
});
