import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { RateLimiter } from './auth.js';
import { databaseOptions } from './database-config.js';
import { createDb, pgAdapter } from './db.js';
import { RealtimeGateway } from './realtime.js';
import { ChatService } from './service.js';
import { SupabaseGateway } from './supabase.js';

/**
 * .env를 읽는다(내 컴퓨터에서 돌릴 때). Vercel에서는 .env가 없고 프로젝트 환경 변수를 쓴다.
 * Node의 --env-file은 이미 있는 환경 변수를 덮어쓰지 않아서, 컴퓨터에 남은 예전 값 때문에 헷갈릴 수 있다.
 * 여기서는 .env가 이긴다.
 */
export function loadEnvFile() {
  const envFile = new URL('../.env', import.meta.url);
  if (!existsSync(envFile)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8').replace(/^﻿/, '')))) {
    if (process.env[key] && process.env[key] !== value) {
      console.warn(`알림: 컴퓨터에 이미 ${key} 환경 변수가 있어서 .env 값으로 바꿔 썼어.`);
    }
    process.env[key] = value;
  }
}

export class ConfigError extends Error {}

function required(env, name) {
  if (!env[name]) throw new ConfigError(`환경 변수 ${name}이(가) 없어. .env.example을 보고 채워 줘.`);
  return env[name];
}

// Postgres의 BIGINT(밀리초 시각)를 문자열이 아닌 숫자로 받는다.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

/** 환경 변수로 DB 연결, 서비스, Supabase 연결을 만든다. 연결은 실제로 쿼리할 때 열린다. */
export function createRuntime(env = process.env) {
  const onVercel = Boolean(env.VERCEL);
  const database = databaseOptions(env);
  if (database.error) throw new ConfigError(`DB 설정 문제: ${database.error}`);

  // Supabase는 SSL 연결이 필요하다. 인증서까지 확인하려면 DATABASE_CA_CERT에 인증서 경로를 넣는다.
  let ssl;
  if (env.DATABASE_SSL === 'disable') ssl = false;
  else if (env.DATABASE_CA_CERT) ssl = { ca: readFileSync(env.DATABASE_CA_CERT, 'utf8'), rejectUnauthorized: true };
  else ssl = { rejectUnauthorized: false };

  const pool = new pg.Pool({
    ...database.options,
    ssl,
    max: Number(env.DATABASE_POOL_SIZE) || (onVercel ? 3 : 10),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000, // 연결이 막혀 있으면 멈춰 있지 말고 15초 뒤 알려 준다
  });
  pool.on('error', (error) => console.error('DB 연결 오류:', error.message));

  const url = required(env, 'SUPABASE_URL');
  const serviceRoleKey = required(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const supabase = new SupabaseGateway({
    url,
    serviceRoleKey,
    anonKey: required(env, 'SUPABASE_ANON_KEY'),
    bucket: env.SUPABASE_BUCKET || 'chat-attachments',
  });

  const db = createDb(pgAdapter(pool));
  const baseUrl = env.BASE_URL ?? '';
  return {
    db,
    pool,
    ssl,
    service: new ChatService(db),
    supabase,
    realtime: new RealtimeGateway({ url, serviceRoleKey }),
    config: {
      secureCookies: onVercel || baseUrl.startsWith('https://'),
      trustProxy: env.TRUST_PROXY || (onVercel ? 1 : false),
      allowedDomains: (env.ALLOWED_EMAIL_DOMAINS ?? '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    },
    signupLimiter: new RateLimiter({ max: 10, windowMs: 10 * 60 * 1000 }),
  };
}
