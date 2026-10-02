import { createChatServer } from './server.js';

const port = Number(process.env.PORT) || 3000;
const { httpServer } = createChatServer();

httpServer.listen(port, () => {
  console.log(`채팅 서버가 http://localhost:${port} 에서 돌고 있어.`);
});
