// 내 컴퓨터에서 돌릴 때: `npm start`
// 처음 켤 때 테이블과 Storage 버킷을 준비하고, http://localhost:3000 에서 연다.
import { explainDbError } from './database-config.js';
import { createChatApp, MAX_UPLOAD } from './create-app.js';
import { ConfigError, createRuntime, loadEnvFile } from './runtime.js';

loadEnvFile();

let runtime;
try {
  runtime = createRuntime();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

try {
  await runtime.db.migrate();
} catch (error) {
  const hint = explainDbError(error);
  console.error(hint ? `DB에 연결하지 못했어요: ${hint}` : error);
  if (hint) console.error(`  (원래 메시지: ${error.message})`);
  process.exit(1);
}

try {
  await runtime.supabase.ensureBucket(MAX_UPLOAD);
} catch (error) {
  console.error(`Supabase에 연결하지 못했어요: ${error.message}`);
  console.error('  SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY가 맞는지 확인해 주세요 (service_role 키 자리에 anon 키를 넣지 않았는지도요).');
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
createChatApp(runtime).listen(port, () => {
  console.log(`채팅 서버: http://localhost:${port}`);
  if (runtime.ssl && !runtime.ssl.rejectUnauthorized) console.log('DB: SSL로 연결 (인증서 확인은 DATABASE_CA_CERT를 넣으면 켜져요)');
});
