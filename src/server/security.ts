import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { isAiStudioContainerEnv } from './config.ts';

export interface SecurityOptions {
  /**
   * Optional bearer/header token required on /api/data mutations (and reads if requireTokenForReads is true).
   * Defaults to process.env.CINETRACK_TOKEN || ''.
   */
  authToken?: string;
  /**
   * Whether GET /api/data (or other guarded GET routes) also requires CINETRACK_TOKEN when configured.
   */
  requireTokenForReads?: boolean;
  /**
   * Effective bind host of the server (defaults to '127.0.0.1').
   * When bound to a non-loopback address without CINETRACK_TOKEN, mutations fail closed with 503 auth_required.
   */
  bindHost?: string;
  /**
   * Whether X-Forwarded-Host and X-Forwarded-For headers from a reverse proxy are trusted.
   * Defaults to false unless CINETRACK_TRUST_PROXY=true or app 'trust proxy' is enabled.
   */
  trustProxy?: boolean;
  /**
   * Maximum /api/tmdb requests per IP within rateLimitWindowMs.
   * Defaults to 0 (disabled) on loopback and 60 req/min on non-loopback hosts.
   */
  rateLimitMaxRequests?: number;
  tmdbRateLimitMax?: number;
  /**
   * Sliding window duration in ms for /api/tmdb rate limiting. Defaults to 60_000 (1 minute).
   */
  rateLimitWindowMs?: number;
  tmdbRateLimitWindowMs?: number;
  /**
   * Additional explicitly allowed origins for state-changing requests.
   */
  allowedOrigins?: string[];
}

function extractRequestToken(req: Request): string {
  const headerToken = req.headers['x-cinetrack-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

export function timingSafeTokenMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const digestProvided = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const digestExpected = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(digestProvided, digestExpected);
}

function normalizeHostValue(raw: string | undefined): string {
  if (!raw) return '';
  return raw.split(',')[0].trim().toLowerCase();
}

export function isLoopbackHostname(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, '').trim().toLowerCase();
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
}

function isTrustedProxyEnabled(
  req: Request,
  options?: Pick<SecurityOptions, 'trustProxy'>
): boolean {
  if (options?.trustProxy !== undefined) return options.trustProxy;
  if (
    !isAiStudioContainerEnv(process.env) &&
    process.env.CINETRACK_TRUST_PROXY?.trim().toLowerCase() === 'true'
  ) {
    return true;
  }
  return Boolean(req.app?.get?.('trust proxy'));
}

/**
 * Validates Origin/Referer against Host for state-changing requests (PUT, POST, DELETE, PATCH).
 * Allows non-browser CLI/server requests that omit Origin & Referer, and allows loopback equivalence
 * (localhost <-> 127.0.0.1 on the same port) for local desktop usage.
 */
export function verifyOriginGuard(
  req: Request,
  allowedOrigins: string[] = [],
  options?: Pick<SecurityOptions, 'trustProxy'>
): { ok: boolean; reason?: string } {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return { ok: true };
  }

  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  const refererHeader = typeof req.headers.referer === 'string' ? req.headers.referer.trim() : '';
  const candidateUrlRaw = originHeader || refererHeader;

  if (!candidateUrlRaw) {
    // Non-browser local client or same-origin request without Origin header
    return { ok: true };
  }

  if (originHeader === 'null') {
    return { ok: false, reason: 'Geçersiz kaynak (null Origin) reddedildi.' };
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(candidateUrlRaw);
  } catch {
    return { ok: false, reason: 'Origin başlığı çözümlenemedi.' };
  }

  const normalizedAllowed = new Set(
    allowedOrigins.map((item) => item.trim().toLowerCase()).filter(Boolean)
  );
  for (const envUrl of [process.env.APP_URL, process.env.SHARED_APP_URL]) {
    if (envUrl) {
      try {
        normalizedAllowed.add(new URL(envUrl).origin.toLowerCase());
      } catch {
        // ignore invalid URL
      }
    }
  }
  if (normalizedAllowed.has(parsedOrigin.origin.toLowerCase())) {
    return { ok: true };
  }

  const trustProxy = isTrustedProxyEnabled(req, options);
  const forwardedHost = trustProxy
    ? normalizeHostValue(req.headers['x-forwarded-host'] as string | undefined)
    : '';
  const hostHeader = forwardedHost || normalizeHostValue(req.headers.host);
  if (!hostHeader) {
    return { ok: true };
  }

  if (parsedOrigin.host.toLowerCase() === hostHeader) {
    return { ok: true };
  }

  // Allow localhost <-> 127.0.0.1 when port matches, and AI Studio preview origins when proxied to loopback
  let expectedHostUrl: URL | null = null;
  try {
    expectedHostUrl = new URL(`http://${hostHeader}`);
  } catch {
    expectedHostUrl = null;
  }

  if (
    expectedHostUrl &&
    isLoopbackHostname(parsedOrigin.hostname) &&
    isLoopbackHostname(expectedHostUrl.hostname) &&
    (parsedOrigin.port || '80') === (expectedHostUrl.port || '80')
  ) {
    return { ok: true };
  }

  if (
    expectedHostUrl &&
    isLoopbackHostname(expectedHostUrl.hostname) &&
    parsedOrigin.protocol === 'https:' &&
    /^ais-(?:dev|pre)-[a-z0-9-]+-\d+\.[a-z0-9-]+\.run\.app$/i.test(parsedOrigin.hostname) &&
    isAiStudioContainerEnv(process.env)
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `CSRF koruması: '${parsedOrigin.origin}' kaynağı '${hostHeader}' sunucusuyla eşleşmiyor.`,
  };
}

export function createOriginMiddleware(options: SecurityOptions = {}) {
  const allowedOrigins = options.allowedOrigins || [];
  return (req: Request, res: Response, next: NextFunction): void => {
    const check = verifyOriginGuard(req, allowedOrigins, { trustProxy: options.trustProxy });
    if (!check.ok) {
      res.status(403).json({
        status_message: check.reason || 'Kaynak doğrulaması başarısız.',
        code: 'csrf_origin_mismatch',
      });
      return;
    }
    next();
  };
}

export function createTokenAuthMiddleware(options: SecurityOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const fallbackEnvToken = isAiStudioContainerEnv(process.env)
      ? ''
      : process.env.CINETRACK_TOKEN ?? '';
    const configuredToken = (options.authToken ?? fallbackEnvToken).trim();
    const bindHost = (options.bindHost ?? '127.0.0.1').trim() || '127.0.0.1';
    const isRead = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';

    if (!configuredToken) {
      if (!isLoopbackHostname(bindHost) && (!isRead || options.requireTokenForReads)) {
        res.status(503).json({
          ok: false,
          error: 'auth_required',
          code: 'auth_required',
          status_message:
            'Uzaktan erişim modunda mutasyonlar için CINETRACK_TOKEN yapılandırması zorunludur.',
        });
        return;
      }
      next();
      return;
    }

    if (isRead && !options.requireTokenForReads) {
      next();
      return;
    }

    const provided = extractRequestToken(req);
    if (!timingSafeTokenMatches(provided, configuredToken)) {
      res.status(401).json({
        status_message: 'Yetkisiz istek: Geçerli CINETRACK_TOKEN gerekli.',
        code: 'unauthorized_token',
      });
      return;
    }
    next();
  };
}

export class SlidingWindowRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(maxRequests = 180, windowMs = 60_000) {
    this.maxRequests = Math.max(1, maxRequests);
    this.windowMs = Math.max(1_000, windowMs);
  }

  check(key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const cutoff = now - this.windowMs;
    const existing = this.hits.get(key) || [];
    const active = existing.filter((ts) => ts > cutoff);

    if (active.length >= this.maxRequests) {
      const oldest = active[0] || now;
      const retryAfterMs = Math.max(1_000, oldest + this.windowMs - now);
      this.hits.set(key, active);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    active.push(now);
    this.hits.set(key, active);
    if (this.hits.size > 2000) {
      const firstKey = this.hits.keys().next().value;
      if (firstKey) this.hits.delete(firstKey);
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - active.length),
      retryAfterSeconds: 0,
    };
  }
}

export function createTmdbRateLimitMiddleware(options: SecurityOptions = {}) {
  const bindHost = (options.bindHost ?? '127.0.0.1').trim() || '127.0.0.1';
  const rawEnvLimit = isAiStudioContainerEnv(process.env)
    ? undefined
    : process.env.CINETRACK_TMDB_RATE_LIMIT;
  const parsedEnvLimit =
    rawEnvLimit !== undefined && rawEnvLimit.trim() !== '' ? Number(rawEnvLimit) : NaN;

  const maxReq =
    options.tmdbRateLimitMax !== undefined
      ? options.tmdbRateLimitMax
      : options.rateLimitMaxRequests !== undefined
        ? options.rateLimitMaxRequests
        : Number.isFinite(parsedEnvLimit) && parsedEnvLimit >= 0
          ? parsedEnvLimit
          : !isLoopbackHostname(bindHost)
            ? 60
            : 0;

  // Localhost personal default: disabled (no-op) unless explicitly enabled via options, env, or non-loopback host
  if (maxReq <= 0) {
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  const windowMs =
    options.tmdbRateLimitWindowMs ??
    options.rateLimitWindowMs ??
    (Number(process.env.CINETRACK_TMDB_RATE_WINDOW_MS) > 0
      ? Number(process.env.CINETRACK_TMDB_RATE_WINDOW_MS)
      : 60_000);
  const limiter = new SlidingWindowRateLimiter(maxReq, windowMs);

  return (req: Request, res: Response, next: NextFunction): void => {
    const trustProxy = isTrustedProxyEnabled(req, options);
    const forwarded =
      trustProxy && typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for']
        : '';
    const clientIp = trustProxy
      ? (forwarded.split(',')[0] || req.ip || req.socket?.remoteAddress || 'local').trim()
      : (req.socket?.remoteAddress || req.ip || 'local').trim();

    const verdict = limiter.check(clientIp);
    res.setHeader('X-RateLimit-Limit', String(maxReq));
    res.setHeader('X-RateLimit-Remaining', String(verdict.remaining));

    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
      res.setHeader('X-CineTrack-Source', 'error');
      res.status(429).json({
        status_message: `Çok fazla TMDB isteği gönderildi. Lütfen ${verdict.retryAfterSeconds} saniye sonra tekrar deneyin.`,
        code: 'rate_limit_exceeded',
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
      return;
    }
    next();
  };
}
