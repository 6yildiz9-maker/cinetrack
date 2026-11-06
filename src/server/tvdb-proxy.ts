import type { Request, Response } from 'express';

export interface TvdbProxyOptions {
  tvdbApiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface TvdbCachedToken {
  token: string;
  expiresAt: number;
  apiKey: string;
}

const DEFAULT_TVDB_BASE_URL = 'https://api4.thetvdb.com/v4';
const MAX_UPSTREAM_BYTES = 10 * 1024 * 1024; // 10 MB

// Whitelist of allowed TVDB v4 paths to proxy
export const ALLOWED_TVDB_PATH_PATTERN =
  /^\/(?:series(?:\/(?:filter|\d+(?:\/(?:extended|translations\/[a-z]{3}|artworks|episodes(?:\/[a-z]+)?)?)?)?)?|movies(?:\/(?:filter|\d+(?:\/(?:extended|translations\/[a-z]{3}|artworks)?)?)?)?|seasons(?:\/\d+(?:\/extended)?)?|episodes(?:\/\d+(?:\/extended)?)?|search(?:\/remoteid)?|genres|artwork\/\d+|people\/\d+(?:\/extended)?|lists(?:\/\d+)?)$/;

export function createTvdbProxyService(options: TvdbProxyOptions = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  let configuredApiKey = (options.tvdbApiKey || '').trim();

  let cachedToken: TvdbCachedToken | null = null;
  const responseCache = new Map<string, { body: any; contentType: string; at: number; ttl: number }>();
  const inFlightRequests = new Map<string, Promise<any>>();

  function resolveApiKey(req?: Request): string {
    const headerKey = req?.headers?.['x-tvdb-api-key'];
    if (typeof headerKey === 'string' && headerKey.trim()) {
      return headerKey.trim();
    }
    const queryKey = req?.query?.apikey;
    if (typeof queryKey === 'string' && queryKey.trim()) {
      return queryKey.trim();
    }
    return configuredApiKey;
  }

  function setConfiguredApiKey(key: string) {
    configuredApiKey = key.trim();
    cachedToken = null;
  }

  async function getValidToken(apiKeyToUse: string, forceRefresh = false): Promise<{ token: string; error?: string }> {
    const key = apiKeyToUse.trim();
    if (!key) {
      return { token: '', error: 'TVDB API anahtarı yapılandırılmamış veya boş.' };
    }

    const now = Date.now();
    if (!forceRefresh && cachedToken && cachedToken.apiKey === key && cachedToken.expiresAt > now + 60_000) {
      return { token: cachedToken.token };
    }

    try {
      const loginUrl = `${DEFAULT_TVDB_BASE_URL}/login`;
      const response = await fetchImpl(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ apikey: key }),
        signal: AbortSignal.timeout(12_000),
      });

      if (!response.ok) {
        const status = response.status;
        let errMsg = `TVDB giriş hatası (${status})`;
        try {
          const errJson = await response.json();
          if (errJson?.message) errMsg = errJson.message;
        } catch {
          // ignore parsing error
        }
        return { token: '', error: errMsg };
      }

      const json = await response.json();
      const token = json?.data?.token;
      if (typeof token !== 'string' || !token) {
        return { token: '', error: 'TVDB yanıtında geçerli bir JWT token bulunamadı.' };
      }

      // Default JWT expiry ~ 28 days
      let expiresAt = now + 28 * 24 * 60 * 60 * 1000;
      try {
        const parts = token.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          if (typeof payload.exp === 'number') {
            expiresAt = payload.exp * 1000;
          }
        }
      } catch {
        // fallback to 28 days
      }

      cachedToken = { token, expiresAt, apiKey: key };
      return { token };
    } catch (err: any) {
      return { token: '', error: err?.message || 'TVDB sunucusuna bağlanılamadı.' };
    }
  }

  const handleStatus = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const apiKey = resolveApiKey(req);
    if (!apiKey) {
      res.json({
        ok: false,
        configured: false,
        tokenActive: false,
        status: 'unconfigured',
        status_message: 'TVDB API anahtarı henüz girilmemiş.',
      });
      return;
    }

    const { token, error } = await getValidToken(apiKey);
    if (!token || error) {
      res.json({
        ok: false,
        configured: true,
        tokenActive: false,
        status: 'invalid_key',
        status_message: error || 'TVDB API anahtarı doğrulanamadı.',
      });
      return;
    }

    res.json({
      ok: true,
      configured: true,
      tokenActive: true,
      status: 'connected',
      status_message: 'TheTVDB v4 API bağlantısı başarılı ve yetkilendirildi.',
    });
  };

  const handleLogin = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const apiKey = (req.body?.apikey || req.body?.apiKey || resolveApiKey(req) || '').trim();
    if (!apiKey) {
      res.status(400).json({ ok: false, status_message: 'apikey parametresi zorunludur.' });
      return;
    }

    const { token, error } = await getValidToken(apiKey, true);
    if (!token) {
      res.status(401).json({ ok: false, status_message: error || 'Giriş başarısız oldu.' });
      return;
    }

    res.json({
      ok: true,
      status_message: 'TVDB v4 oturumu açıldı.',
      tokenExpiresAt: cachedToken?.expiresAt,
    });
  };

  const handleTvdb = async (req: Request, res: Response): Promise<void> => {
    const rawEndpoint = String(req.query.endpoint || '').trim();
    if (!rawEndpoint) {
      res.status(400).json({ status_message: 'endpoint parametresi zorunludur (ör: /series/filter).' });
      return;
    }

    const normalizedEndpoint = rawEndpoint.startsWith('/') ? rawEndpoint : `/${rawEndpoint}`;
    const cleanPath = normalizedEndpoint.split('?')[0];

    if (!ALLOWED_TVDB_PATH_PATTERN.test(cleanPath)) {
      res.status(400).json({ status_message: `İstenen TVDB uç noktası izin listesinde yok: ${cleanPath}` });
      return;
    }

    const apiKey = resolveApiKey(req);
    if (!apiKey) {
      res.status(503).json({
        status_message: 'TVDB_API_KEY eksik. Ayarlar bölümünden TVDB API anahtarınızı girin.',
        source: 'tvdb',
      });
      return;
    }

    // Build URL with query params (excluding endpoint & apikey)
    const targetUrl = new URL(`${DEFAULT_TVDB_BASE_URL}${normalizedEndpoint}`);
    for (const [key, value] of Object.entries(req.query)) {
      if (key !== 'endpoint' && key !== 'apikey' && typeof value === 'string') {
        targetUrl.searchParams.set(key, value);
      }
    }

    const cacheKey = targetUrl.toString();
    const cached = responseCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.at < cached.ttl) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=180');
      res.setHeader('X-CineTrack-Source', 'tvdb');
      res.setHeader('X-CineTrack-Cache', 'hit');
      res.send(cached.body);
      return;
    }

    const executeUpstream = async (isRetry = false): Promise<any> => {
      const { token, error } = await getValidToken(apiKey, isRetry);
      if (!token) {
        throw new Error(error || 'TVDB oturum açma başarısız.');
      }

      const upstream = await fetchImpl(targetUrl.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'Cinethos-TVDB-Proxy/1.0',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (upstream.status === 401 && !isRetry) {
        // Token might be revoked or expired; invalidate and retry once
        cachedToken = null;
        return executeUpstream(true);
      }

      const status = upstream.status;
      const contentType = upstream.headers.get('content-type') || 'application/json';

      if (status === 429) {
        const retryAfter = upstream.headers.get('retry-after') || '5';
        res.setHeader('Retry-After', retryAfter);
        res.status(429).json({
          status_message: 'TVDB istek limiti aşıldı. Lütfen birkaç saniye sonra tekrar deneyin.',
          retryAfter,
        });
        return null;
      }

      const rawText = await upstream.text();
      if (rawText.length > MAX_UPSTREAM_BYTES) {
        res.status(413).json({ status_message: 'TVDB yanıt boyutu sınırı aştı.' });
        return null;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = { raw: rawText };
      }

      if (!upstream.ok) {
        res.status(status).json(parsed);
        return null;
      }

      // Cache successful response (5 min TTL)
      responseCache.set(cacheKey, {
        body: rawText,
        contentType,
        at: Date.now(),
        ttl: 5 * 60 * 1000,
      });

      // Maintain cache size
      while (responseCache.size > 200) {
        const firstKey = responseCache.keys().next().value;
        if (firstKey) responseCache.delete(firstKey);
        else break;
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=180');
      res.setHeader('X-CineTrack-Source', 'tvdb');
      res.setHeader('X-CineTrack-Cache', 'miss');
      res.send(rawText);
      return parsed;
    };

    try {
      let pending = inFlightRequests.get(cacheKey);
      if (!pending) {
        pending = executeUpstream().finally(() => inFlightRequests.delete(cacheKey));
        inFlightRequests.set(cacheKey, pending);
      }
      await pending;
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(502).json({
          status_message: err?.message || 'TVDB sunucusuna bağlanırken hata oluştu.',
          code: 'upstream_tvdb_error',
        });
      }
    }
  };

  return {
    handleStatus,
    handleLogin,
    handleTvdb,
    setConfiguredApiKey,
    resolveApiKey,
    getValidToken,
    responseCache,
  };
}
