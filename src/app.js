// Vercel이 이 파일을 Express 앱으로 띄운다(export default app).
// Vercel은 express를 직접 import하는 파일만 진입점으로 알아보므로 여기서 감싼다.
// 테이블과 Storage 버킷, 실시간 권한은 미리 만들어져 있어야 한다(README의 "처음 설정하기").
import express from 'express';
import { createChatApp } from './create-app.js';
import { createRuntime, loadEnvFile } from './runtime.js';

loadEnvFile();

const app = express();
app.disable('x-powered-by');
app.use(createChatApp(createRuntime()));

export default app;
