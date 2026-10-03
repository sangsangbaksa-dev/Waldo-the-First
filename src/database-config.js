import { parse } from 'pg-connection-string';

/**
 * .env에서 DB 접속 정보를 읽는다. 두 가지 방법을 받는다.
 * 1) DATABASE_HOST / DATABASE_USER / DATABASE_PASSWORD 를 따로 (권장: 비밀번호에 @ 등이 있어도 그대로 적으면 됨)
 * 2) DATABASE_URL 한 줄
 * 잘못되면 { error }에 무엇을 고쳐야 하는지 한국어로 담는다. 비밀번호는 메시지에 넣지 않는다.
 */
export function databaseOptions(env) {
  const host = env.DATABASE_HOST?.trim();
  if (host) {
    const missing = ['DATABASE_USER', 'DATABASE_PASSWORD'].filter((k) => !env[k]);
    if (missing.length) return { error: `.env에 ${missing.join(', ')}이(가) 비어 있어.` };
    const user = env.DATABASE_USER.trim();
    if (host.includes('pooler.supabase.com') && !/^postgres\.[a-z0-9]+$/.test(user)) {
      return { error: `DATABASE_USER는 "postgres.프로젝트ID" 모양이어야 해 (예: postgres.rcuqtoaxtkudzoxnswqk). 지금 값: "${user}"` };
    }
    return {
      options: {
        host,
        port: Number(env.DATABASE_PORT) || 5432,
        user,
        password: env.DATABASE_PASSWORD,
        database: env.DATABASE_NAME?.trim() || 'postgres',
      },
    };
  }

  const url = env.DATABASE_URL?.trim();
  if (!url) return { error: '.env에 DATABASE_HOST, DATABASE_USER, DATABASE_PASSWORD를 채워 줘.' };
  let parsed;
  try {
    // pg가 실제로 쓰는 해석기로 확인해야 똑같이 실패하는 주소를 미리 잡을 수 있다.
    parsed = parse(url);
    new URL(url);
  } catch {
    return {
      error:
        'DATABASE_URL 모양이 잘못됐어. 비밀번호의 #·/·? 같은 기호나 띄어쓰기 때문일 때가 많아.\n' +
        '  더 쉬운 방법: DATABASE_URL 줄을 지우고 DATABASE_HOST, DATABASE_USER, DATABASE_PASSWORD를 따로 적어 줘 (.env.example 참고).',
    };
  }
  if (!/^postgres(ql)?:/.test(url)) return { error: 'DATABASE_URL은 postgresql:// 로 시작해야 해.' };
  if (/\[YOUR-PASSWORD\]/i.test(url)) return { error: 'DATABASE_URL의 [YOUR-PASSWORD]를 대괄호까지 지우고 진짜 DB 비밀번호로 바꿔 줘.' };
  if (parsed.host?.includes('pooler.supabase.com') && !/^postgres\.[a-z0-9]+$/.test(parsed.user ?? '')) {
    return { error: `DATABASE_URL의 사용자 이름은 "postgres.프로젝트ID" 모양이어야 해. 지금 값: "${parsed.user ?? ''}"` };
  }
  return { options: { connectionString: url } };
}

/** DB에 처음 붙을 때 난 에러를 고칠 방법으로 바꿔 준다. */
export function explainDbError(error) {
  const text = `${error.code ?? ''} ${error.message ?? ''}`;
  if (/Invalid format for user or db_name/i.test(text)) {
    return 'DB 사용자 이름 형식이 틀렸어. DATABASE_USER를 "postgres.프로젝트ID"로, DATABASE_NAME은 비우거나 postgres로 둬.';
  }
  if (/Tenant or user not found/i.test(text)) {
    return 'DB 서버 주소와 사용자 이름이 안 맞아. 대시보드 Connect → Session pooler의 host와 user를 그대로 옮겨 적어.';
  }
  if (error.code === '28P01' || /password authentication failed/i.test(text)) {
    return 'DB 비밀번호가 틀렸어. DATABASE_PASSWORD에 비밀번호를 그대로 적어 (따옴표나 %40 변환 없이). 모르겠으면 대시보드 Database → Settings에서 새로 정해.';
  }
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
    return 'DB 서버 주소를 찾을 수 없어. DATABASE_HOST 철자를 확인하고 인터넷 연결을 확인해.';
  }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH'].includes(error.code)) {
    return 'DB 서버에 연결할 수 없어. 포트(5432)가 맞는지, 학교·회사 네트워크가 막고 있지 않은지 확인해.';
  }
  return null;
}
