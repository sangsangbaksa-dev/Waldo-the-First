// Vercel이 이 파일을 Express 앱으로 띄운다(export default app).
// 테이블과 Storage 버킷은 미리 만들어져 있어야 한다: 내 컴퓨터에서 `npm start`를 한 번 하거나 supabase/*.sql을 실행.
import { createChatApp } from './create-app.js';
import { createRuntime, loadEnvFile } from './runtime.js';

loadEnvFile();
const runtime = createRuntime();

export default createChatApp(runtime);
