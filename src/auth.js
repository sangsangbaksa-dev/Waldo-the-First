import { ChatError, normalizeEmail, validateName } from './service.js';

export const SESSION_COOKIE = 'chat_session';
export const PASSWORD_MIN = 8;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

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

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN) {
    throw new ChatError(400, `비밀번호는 ${PASSWORD_MIN}자 이상이어야 해.`);
  }
  if (value.length > 72) throw new ChatError(400, '비밀번호는 72자까지야.');
  return value;
}

/** 허용한 도메인만 가입할 수 있게 한다. 비워 두면 모두 허용. */
export function emailAllowed(config, email) {
  if (!config.allowedDomains.length) return true;
  return config.allowedDomains.includes(email.split('@')[1]?.toLowerCase());
}

/** 짧은 시간에 같은 곳에서 너무 많이 시도하는 걸 막는다. */
export class RateLimiter {
  constructor({ max, windowMs, now = Date.now }) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  allow(key) {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    const ok = recent.length < this.max;
    if (ok) recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10000) this.hits.clear();
    return ok;
  }
}

/**
 * 계정은 Supabase Auth에 있다.
 * - 가입: 서버가 관리자 API로 계정을 만든다(인증 메일·승인 없음). 바로 로그인된다.
 * - 로그인: 브라우저가 Supabase에 이메일·비밀번호를 직접 보내 access token을 받고,
 *   서버는 그 토큰을 확인한 뒤 이 사이트의 세션 쿠키를 준다.
 */
export function mountAuth(app, { service, supabase, config, signupLimiter = new RateLimiter({ max: 10, windowMs: 10 * 60 * 1000 }) }) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: '/',
    maxAge: SESSION_MS,
  };
  const startSession = async (res, user) => {
    res.cookie(SESSION_COOKIE, await service.createSession(user.id, SESSION_MS), cookieOptions);
  };

  app.post('/auth/signup', async (req, res) => {
    if (!signupLimiter.allow(req.ip)) throw new ChatError(429, '가입 시도가 너무 많아. 잠시 뒤에 다시 해 줘.');
    const name = validateName(req.body?.name);
    const email = normalizeEmail(req.body?.email);
    const password = validatePassword(req.body?.password);
    if (!emailAllowed(config, email)) throw new ChatError(403, '이 이메일 도메인으로는 가입할 수 없어.');
    if (await service.emailRegistered(email)) throw new ChatError(409, '이미 가입된 이메일이야. 로그인해 줘.');

    const account = await supabase.createUser({ email, password, name });
    const user = await service.linkAccount({ authId: account.id, email, name });
    await startSession(res, user);
    res.status(201).json({ user });
  });

  app.post('/auth/session', async (req, res) => {
    const account = await supabase.userFromAccessToken(req.body?.accessToken);
    if (!account?.email) throw new ChatError(401, '로그인 정보를 확인할 수 없어. 다시 로그인해 줘.');
    if (!emailAllowed(config, account.email)) throw new ChatError(403, '이 사이트에 들어올 수 없는 계정이야.');
    const user = await service.linkAccount({ authId: account.id, email: account.email, name: account.name });
    await startSession(res, user);
    res.json({ user });
  });

  app.post('/auth/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await service.deleteSession(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });
}
