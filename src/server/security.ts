import type { Request, Response, NextFunction } from 'express';

export interface SecurityOptions {
  /**
   * Optional bearer/header token required on /api/data mutations (and reads if requireTokenForReads is true).
   * Defaults to process.env.CINETRACK_TOKEN || ''.
   */
  authToken?: string;
  /**
   * Whether GET /api/data also requires CINETRACK_TOKEN when configured. Defaults to false so local read works unless strict.
   */
  requireTokenForReads?: boolean;
  /**
   * Maximum /api/tmdb requests per IP within rateLimitWindowMs. Defaults to 180.
   */
  rateLimitMaxRequests?: number;
  /**
   * Sliding window duration in ms for /api/tmdb rate limiting. Defaults to 60_000 (1 minute).
   */
  rateLimitWindowMs?: number;
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

function normalizeHostValue(raw: string | undefined): string {
  if (!raw) return '';
  return raw.split(',')[0].trim().toLowerCase();
}

export function isLoopbackHostname(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
}

/**
 * Validates Origin/Referer against Host for state-changing requests (PUT, POST, DELETE, PATCH).
 * Allows non-browser CLI/server requests that omit Origin & Referer, and allows loopback equivalence
 * (localhost <-> 127.0.0.1 on the same port) for local desktop usage.
 */
export function verifyOriginGuard(req: Request, allowedOrigins: string[] = []): { ok: boolean; reason?: string } {
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

  const normalizedAllowed = new Set(allowedOrigins.map((item) => item.trim().toLowerCase()).filter(Boolean));
  if (normalizedAllowed.has(parsedOrigin.origin.toLowerCase())) {
    return { ok: true };
  }

  const forwardedHost = normalizeHostValue(req.headers['x-forwarded-host'] as string | undefined);
  const hostHeader = forwardedHost || normalizeHostValue(req.headers.host);
  if (!hostHeader) {
    return { ok: true };
  }

  if (parsedOrigin.host.toLowerCase() === hostHeader) {
    return { ok: true };
  }

  // Allow localhost <-> 127.0.0.1 when port matches
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

  return {
    ok: false,
    reason: `CSRF koruması: '${parsedOrigin.origin}' kaynağı '${hostHeader}' sunucusuyla eşleşmiyor.`,
  };
}

export function createOriginMiddleware(options: SecurityOptions = {}) {
  const allowedOrigins = options.allowedOrigins || [];
  return (req: Request, res: Response, next: NextFunction): void => {
    const check = verifyOriginGuard(req, allowedOrigins);
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
    const configuredToken = (options.authToken ?? process.env.CINETRACK_TOKEN ?? '').trim();
    if (!configuredToken) {
      next();
      return;
    }

    const isRead = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (isRead && !options.requireTokenForReads) {
      next();
      return;
    }

    const provided = extractRequestToken(req);
    if (!provided || provided !== configuredToken) {
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
  const envMax = Number(process.env.CINETRACK_TMDB_RATE_LIMIT) || 0;
  const maxReq = options.rateLimitMaxRequests ?? (envMax > 0 ? envMax : 0);

  // Localhost personal default: disabled (no-op) unless explicitly enabled via options or env
  if (maxReq <= 0) {
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  const windowMs =
    options.rateLimitWindowMs ??
    (Number(process.env.CINETRACK_TMDB_RATE_WINDOW_MS) > 0
      ? Number(process.env.CINETRACK_TMDB_RATE_WINDOW_MS)
      : 60_000);
  const limiter = new SlidingWindowRateLimiter(maxReq, windowMs);

  return (req: Request, res: Response, next: NextFunction): void => {
    const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
    const clientIp = (forwarded.split(',')[0] || req.ip || req.socket?.remoteAddress || 'local').trim();
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
