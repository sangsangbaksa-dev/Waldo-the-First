import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

/** 쿼리에 `?`로 쓴 자리를 Postgres의 $1, $2…로 바꾼다. */
export function positional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function wrap(runner) {
  const query = async (sql, params = []) => (await runner(positional(sql), params)).rows;
  return {
    all: query,
    one: async (sql, params) => (await query(sql, params))[0],
    run: async (sql, params) => {
      await query(sql, params);
    },
  };
}

/**
 * pg(Supabase)와 PGlite(테스트)를 같은 모양으로 쓰게 하는 얇은 층.
 * adapter: { query(text, params), exec(sql), transaction(fn(runner)) }
 */
export function createDb(adapter) {
  return {
    ...wrap((text, params) => adapter.query(text, params)),
    migrate: () => adapter.exec(schema),
    /** fn 안의 쿼리는 모두 한 트랜잭션으로 묶인다. */
    tx: (fn) => adapter.transaction((runner) => fn(wrap(runner))),
    close: () => adapter.close?.(),
  };
}

export function pgAdapter(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn((text, params) => client.query(text, params));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function pgliteAdapter(pglite) {
  return {
    query: (text, params) => pglite.query(text, params),
    exec: (sql) => pglite.exec(sql),
    transaction: (fn) => pglite.transaction((tx) => fn((text, params) => tx.query(text, params))),
    close: () => pglite.close(),
  };
}
