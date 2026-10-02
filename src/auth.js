import { randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'chat_session';
const STATE_COOKIE = 'chat_oauth_state';

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    try {
      cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // 깨진 쿠키는 무시한다.
    }
  }
  return cookies;
}

function cookieOptions(config, maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
    path: '/',
    maxAge: maxAgeMs,
  };
}

/** 허용한 도메인(예: gmail.com, school.kr)만 들어올 수 있게 한다. 비워 두면 모두 허용. */
export function emailAllowed(config, email) {
  if (!config.allowedDomains.length) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return config.allowedDomains.includes(domain);
}

function decodeJwtPayload(token) {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/**
 * 구글 OAuth 2.0 (OpenID Connect) 로그인.
 * id_token은 TLS로 구글 토큰 엔드포인트에서 직접 받으므로 서명 대신 aud/iss/만료를 확인한다.
 */
export function mountAuth(app, { service, config, fetchImpl = fetch }) {
  const startSession = (res, user) => {
    const token = service.createSession(user.id);
    res.cookie(SESSION_COOKIE, token, cookieOptions(config, 30 * 24 * 60 * 60 * 1000));
  };

  app.get('/auth/google', (_req, res) => {
    if (!config.google) return res.status(404).send('구글 로그인이 설정되지 않았어.');
    const state = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, cookieOptions(config, 10 * 60 * 1000));
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: `${config.baseUrl}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get('/auth/google/callback', async (req, res) => {
    const back = (error) => res.redirect(`/?error=${encodeURIComponent(error)}`);
    if (!config.google) return back('구글 로그인이 설정되지 않았어.');

    const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (req.query.error) return back('구글 로그인을 취소했어.');
    if (!expected || req.query.state !== expected || typeof req.query.code !== 'string') {
      return back('로그인 요청이 만료됐어. 다시 시도해 줘.');
    }

    let claims;
    try {
      const response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: `${config.baseUrl}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      if (!response.ok) throw new Error(`token endpoint ${response.status}`);
      const tokens = await response.json();
      claims = decodeJwtPayload(tokens.id_token);
    } catch (error) {
      console.error('구글 로그인 실패:', error.message);
      return back('구글 로그인에 실패했어.');
    }

    const issuerOk = ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss);
    if (!issuerOk || claims.aud !== config.google.clientId || claims.exp * 1000 < Date.now()) {
      return back('구글 로그인 정보를 확인할 수 없어.');
    }
    if (!claims.email || !claims.email_verified) return back('인증된 이메일이 있는 구글 계정만 쓸 수 있어.');
    if (!emailAllowed(config, claims.email)) return back('이 사이트에 들어올 수 없는 계정이야.');

    const user = service.signIn({ email: claims.email, name: claims.name, avatar: claims.picture ?? null });
    startSession(res, user);
    res.redirect('/');
  });

  // 구글 키 없이 로컬에서 써 보기 위한 로그인. 운영에서는 DEV_LOGIN을 끄면 된다.
  app.post('/auth/dev', (req, res) => {
    if (!config.devLogin) return res.status(404).json({ error: '개발용 로그인이 꺼져 있어.' });
    const { email, name } = req.body ?? {};
    const user = service.signIn({ email, name });
    if (!emailAllowed(config, user.email)) return res.status(403).json({ error: '이 사이트에 들어올 수 없는 계정이야.' });
    startSession(res, user);
    res.json({ user });
  });

  app.post('/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) service.deleteSession(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });
}
