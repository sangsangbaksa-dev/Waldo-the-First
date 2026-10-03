import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseOptions, explainDbError } from '../src/database-config.js';

const HOST = 'aws-1-ap-southeast-1.pooler.supabase.com';

test('따로 적은 값은 비밀번호의 @도 그대로 쓴다', () => {
  const { options } = databaseOptions({ DATABASE_HOST: HOST, DATABASE_USER: 'postgres.abc123', DATABASE_PASSWORD: '@kk1#[x]' });
  assert.deepEqual(options, { host: HOST, port: 5432, user: 'postgres.abc123', password: '@kk1#[x]', database: 'postgres' });
});

test('빠진 값이나 잘못된 사용자 이름을 알려 준다', () => {
  assert.match(databaseOptions({ DATABASE_HOST: HOST, DATABASE_USER: 'postgres' }).error, /DATABASE_PASSWORD/);
  assert.match(databaseOptions({ DATABASE_HOST: HOST, DATABASE_USER: 'postgres', DATABASE_PASSWORD: 'p' }).error, /postgres\.프로젝트ID/);
  assert.match(databaseOptions({}).error, /DATABASE_HOST/);
});

test('주소 한 줄도 받고, 깨진 주소는 비밀번호를 드러내지 않고 알려 준다', () => {
  const ok = `postgresql://postgres.abc123:%40pw@${HOST}:5432/postgres`;
  assert.deepEqual(databaseOptions({ DATABASE_URL: ok }).options, { connectionString: ok });
  const bad = databaseOptions({ DATABASE_URL: 'postgresql://postgres.abc:secret#pw@host:5432/postgres' }).error;
  assert.match(bad, /형식이 잘못됐어요/);
  assert.doesNotMatch(bad, /secret/);
  assert.match(databaseOptions({ DATABASE_URL: `postgresql://postgres:pw@${HOST}:5432/postgres` }).error, /postgres\.프로젝트ID/);
  assert.match(databaseOptions({ DATABASE_URL: `postgresql://postgres.abc:[YOUR-PASSWORD]@${HOST}:5432/postgres` }).error, /YOUR-PASSWORD/);
});

test('자주 나는 DB 에러를 고칠 방법으로 바꾼다', () => {
  assert.match(explainDbError({ message: 'Invalid format for user or db_name' }), /사용자 이름 형식/);
  assert.match(explainDbError({ code: '28P01', message: 'password authentication failed for user' }), /비밀번호가 틀렸어/);
  assert.match(explainDbError({ message: 'Tenant or user not found' }), /맞지 않아요/);
  assert.match(explainDbError({ code: 'ENOTFOUND' }), /주소를 찾을 수 없어/);
  assert.equal(explainDbError({ message: 'something else' }), null);
});
