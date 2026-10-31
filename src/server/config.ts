import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TokenSourceKind } from './persistent-store.ts';

export interface ParsedDotenvResult {
  values: Record<string, string>;
  warnings: string[];
}

/**
 * Standart dotenv uyumlu ayrıştırıcı (EXT-13):
 * - `export KEY=VALUE` önekini destekler
 * - Tek tırnak ('...'), çift tırnak ("..." ve kaçış dizileri \n, \r, \t, \", \\) ve çok satırlı tırnaklı değerleri destekler
 * - Tırnaksız değerlerde satır içi `#` yorumlarını temizler
 * - Bozuk satırlarda sır değerini sızdırmadan uyarı üretir
 */
export function parseDotenvContent(content: string, sourceLabel = '.env'): ParsedDotenvResult {
  const values: Record<string, string> = {};
  const warnings: string[] = [];
  if (typeof content !== 'string' || !content) {
    return { values, warnings };
  }

  const lines = content.split(/\r?\n/);
  let idx = 0;

  while (idx < lines.length) {
    const rawLine = lines[idx];
    const lineNo = idx + 1;
    idx += 1;

    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trimStart()
      : trimmed;

    const eqIndex = withoutExport.indexOf('=');
    if (eqIndex < 1) {
      warnings.push(
        `[Config] ${sourceLabel}:${lineNo} bozuk satır atlandı ('=' ayracı bulunamadı).`
      );
      continue;
    }

    const key = withoutExport.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      warnings.push(
        `[Config] ${sourceLabel}:${lineNo} geçersiz ortam değişkeni adı atlandı.`
      );
      continue;
    }

    const rawRhs = withoutExport.slice(eqIndex + 1).trimStart();
    if (!rawRhs) {
      values[key] = '';
      continue;
    }

    const quoteChar = rawRhs[0];
    if (quoteChar === '"' || quoteChar === "'") {
      let cursor = 1;
      let currentChunk = rawRhs;
      let acc = '';
      let closed = false;

      while (true) {
        while (cursor < currentChunk.length) {
          const ch = currentChunk[cursor];
          if (quoteChar === '"' && ch === '\\' && cursor + 1 < currentChunk.length) {
            const nextChar = currentChunk[cursor + 1];
            if (nextChar === 'n') acc += '\n';
            else if (nextChar === 'r') acc += '\r';
            else if (nextChar === 't') acc += '\t';
            else if (nextChar === '"') acc += '"';
            else if (nextChar === '\\') acc += '\\';
            else acc += nextChar;
            cursor += 2;
            continue;
          }
          if (ch === quoteChar) {
            closed = true;
            const trailing = currentChunk.slice(cursor + 1).trim();
            if (trailing && !trailing.startsWith('#')) {
              warnings.push(
                `[Config] ${sourceLabel}:${lineNo} (${key}) kapanış tırnağından sonra beklenmeyen karakterler yoksayıldı.`
              );
            }
            break;
          }
          acc += ch;
          cursor += 1;
        }

        if (closed) break;
        if (idx >= lines.length) {
          warnings.push(
            `[Config] ${sourceLabel}:${lineNo} (${key}) kapatılmamış tırnak algılandı.`
          );
          break;
        }
        acc += '\n';
        currentChunk = lines[idx];
        idx += 1;
        cursor = 0;
      }

      values[key] = acc;
      continue;
    }

    // Tırnaksız değer: boşluktan sonra gelen `#` satır içi yorum başlangıcıdır
    let commentStart = -1;
    for (let i = 0; i < rawRhs.length; i += 1) {
      if (rawRhs[i] === '#' && (i === 0 || /\s/.test(rawRhs[i - 1]))) {
        commentStart = i;
        break;
      }
    }
    const cleanVal = (commentStart >= 0 ? rawRhs.slice(0, commentStart) : rawRhs).trim();
    values[key] = cleanVal;
  }

  return { values, warnings };
}

export interface ResolvedServerConfig {
  port: number;
  defaultLoopbackHost: '127.0.0.1';
  explicitHost: string | undefined;
  listenHost: string;
  effectiveBindHost: string;
  isRemoteHostWithoutToken: boolean;
  tmdbApiKey: string;
  authToken: string;
  suggestedAuthToken?: string;
  trustProxy: boolean;
  tmdbRateLimit: number | undefined;
  tmdbRateWindowMs: number | undefined;
  githubToken: string;
  githubTokenSource: TokenSourceKind;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  isPublicRepo: boolean;
  allowPublicPersonalSync: boolean | undefined;
  allowPublicCatalogSync: boolean | undefined;
  processEnvIsPublicRepo: string | null;
  localEnvIsPublicRepo: string | null;
  warnings: string[];
}

export interface ResolveConfigOptions {
  env?: Record<string, string | undefined>;
  processEnv?: Record<string, string | undefined>;
  rootDir?: string;
  envLocalContent?: string;
  dotEnvContent?: string;
}

function parseOptionalBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function isLoopbackBindHost(host: string): boolean {
  const clean = host.replace(/^\[|\]$/g, '').trim().toLowerCase();
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1';
}

/**
 * Tek kaynaklı sunucu yapılandırma çözümleyicisi (EXT-09 & BUG-01):
 * Tüm değişkenler için tek öncelik kuralı: `process.env > .env.local > .env > güvenli varsayılan`.
 * Birincil GitHub anahtarı `CINETRACK_GITHUB_PAT` olarak seçilir; `CINETRACK_GITHUB_TOKEN` yalnızca geri uyumluluk yedeğidir.
 */
export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedServerConfig {
  const env = options.processEnv ?? options.env ?? process.env;
  const warnings: string[] = [];

  let envLocalValues: Record<string, string> = {};
  let dotEnvValues: Record<string, string> = {};

  if (typeof options.envLocalContent === 'string') {
    const parsed = parseDotenvContent(options.envLocalContent, '.env.local');
    envLocalValues = parsed.values;
    warnings.push(...parsed.warnings);
  } else if (options.rootDir) {
    const p = path.join(options.rootDir, '.env.local');
    if (existsSync(p)) {
      const parsed = parseDotenvContent(readFileSync(p, 'utf8'), '.env.local');
      envLocalValues = parsed.values;
      warnings.push(...parsed.warnings);
    }
  }

  if (typeof options.dotEnvContent === 'string') {
    const parsed = parseDotenvContent(options.dotEnvContent, '.env');
    dotEnvValues = parsed.values;
    warnings.push(...parsed.warnings);
  } else if (options.rootDir) {
    const p = path.join(options.rootDir, '.env');
    if (existsSync(p)) {
      const parsed = parseDotenvContent(readFileSync(p, 'utf8'), '.env');
      dotEnvValues = parsed.values;
      warnings.push(...parsed.warnings);
    }
  }

  const pickRaw = (key: string): string | undefined => {
    if (env[key] !== undefined) return env[key];
    if (key in envLocalValues) return envLocalValues[key];
    if (key in dotEnvValues) return dotEnvValues[key];
    return undefined;
  };

  const pickNonEmpty = (key: string): string | undefined => {
    const envVal = env[key]?.trim();
    if (envVal) return envVal;
    const localVal = envLocalValues[key]?.trim();
    if (localVal) return localVal;
    const dotVal = dotEnvValues[key]?.trim();
    if (dotVal) return dotVal;
    return undefined;
  };

  const defaultLoopbackHost = '127.0.0.1' as const;
  const rawCinetrackHost = pickNonEmpty('CINETRACK_HOST');
  const rawHost = pickNonEmpty('HOST');
  const explicitHost = rawCinetrackHost || rawHost;
  const isAiStudioContainer = Boolean(env.APP_URL) && !explicitHost;
  const effectiveBindHost = explicitHost || defaultLoopbackHost;
  const listenHost = explicitHost || (isAiStudioContainer ? '0.0.0.0' : defaultLoopbackHost);

  const rawPort = Number(pickNonEmpty('PORT')) || Number(pickNonEmpty('CINETRACK_PORT')) || 3000;
  const port = Number.isSafeInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 3000;

  const tmdbApiKey = pickNonEmpty('TMDB_API_KEY') || '';
  const authToken = pickNonEmpty('CINETRACK_TOKEN') || '';
  const isRemoteHostWithoutToken = !isLoopbackBindHost(effectiveBindHost) && !authToken;

  const suggestedAuthToken = !authToken ? crypto.randomBytes(24).toString('hex') : undefined;

  if (isRemoteHostWithoutToken) {
    warnings.push(
      `[GÜVENLİK UYARISI] Sunucu harici ağ arayüzünde (${effectiveBindHost}) CINETRACK_TOKEN olmadan başlatıldı! Uzak mutasyonlar 503 auth_required ile reddedilecek. Önerilen .env.local ayarı: CINETRACK_TOKEN=${suggestedAuthToken}`
    );
  }

  const trustProxy = parseOptionalBool(pickRaw('CINETRACK_TRUST_PROXY')) === true;

  const rawRateLimit = pickNonEmpty('CINETRACK_TMDB_RATE_LIMIT');
  const parsedRateLimit = rawRateLimit !== undefined ? Number(rawRateLimit) : NaN;
  const tmdbRateLimit =
    Number.isFinite(parsedRateLimit) && parsedRateLimit >= 0 ? parsedRateLimit : undefined;

  const rawWindowMs = pickNonEmpty('CINETRACK_TMDB_RATE_WINDOW_MS');
  const parsedWindowMs = rawWindowMs !== undefined ? Number(rawWindowMs) : NaN;
  const tmdbRateWindowMs =
    Number.isFinite(parsedWindowMs) && parsedWindowMs > 0 ? parsedWindowMs : undefined;

  // GitHub PAT çözümleme: katman önceliği process.env > .env.local > .env; katman içinde CINETRACK_GITHUB_PAT > CINETRACK_GITHUB_TOKEN
  let githubToken = '';
  let githubTokenSource: TokenSourceKind = 'none';

  const envPat = env.CINETRACK_GITHUB_PAT?.trim() || '';
  const envLegacyTok = env.CINETRACK_GITHUB_TOKEN?.trim() || '';
  const localPat = envLocalValues.CINETRACK_GITHUB_PAT?.trim() || '';
  const localLegacyTok = envLocalValues.CINETRACK_GITHUB_TOKEN?.trim() || '';
  const dotPat = dotEnvValues.CINETRACK_GITHUB_PAT?.trim() || '';
  const dotLegacyTok = dotEnvValues.CINETRACK_GITHUB_TOKEN?.trim() || '';

  if (envPat) {
    githubToken = envPat;
    githubTokenSource = 'env:CINETRACK_GITHUB_PAT';
  } else if (envLegacyTok) {
    githubToken = envLegacyTok;
    githubTokenSource = 'env:CINETRACK_GITHUB_TOKEN';
  } else if (localPat) {
    githubToken = localPat;
    githubTokenSource = 'dotenv_local_pat';
  } else if (localLegacyTok) {
    githubToken = localLegacyTok;
    githubTokenSource = 'file:.env.local:CINETRACK_GITHUB_TOKEN';
  } else if (dotPat) {
    githubToken = dotPat;
    githubTokenSource = 'dotenv_pat';
  } else if (dotLegacyTok) {
    githubToken = dotLegacyTok;
    githubTokenSource = 'file:.env:CINETRACK_GITHUB_TOKEN';
  }

  // Token gölgeleme / çakışma tespiti (sırları göstermeden)
  const effectivePat = envPat || localPat || dotPat;
  const effectiveLegacy = envLegacyTok || localLegacyTok || dotLegacyTok;
  if (effectivePat && effectiveLegacy && effectivePat !== effectiveLegacy) {
    warnings.push(
      '[Config] Hem CINETRACK_GITHUB_PAT hem de eski CINETRACK_GITHUB_TOKEN tanımlı ve birbirinden farklı; birincil kural gereği öncelikli katmandaki CINETRACK_GITHUB_PAT / ortam değişkeni seçildi.'
    );
  }
  if (envPat && (localPat || dotPat) && envPat !== (localPat || dotPat)) {
    warnings.push(
      '[Config] process.env.CINETRACK_GITHUB_PAT değeri yerel .env/.env.local dosyasındaki eski anahtarı geçersiz kıldı (process.env önceliklidir).'
    );
  }

  const githubOwner = pickNonEmpty('CINETRACK_DATA_OWNER') || '6yildiz9-maker';
  const githubRepo = pickNonEmpty('CINETRACK_DATA_REPO') || 'cinetrack-private-data';
  const githubBranch = pickNonEmpty('CINETRACK_DATA_BRANCH') || 'main';

  const processEnvIsPublicRepo =
    env.CINETRACK_DATA_REPO_IS_PUBLIC !== undefined ? env.CINETRACK_DATA_REPO_IS_PUBLIC : null;
  const localEnvIsPublicRepo =
    envLocalValues.CINETRACK_DATA_REPO_IS_PUBLIC !== undefined
      ? envLocalValues.CINETRACK_DATA_REPO_IS_PUBLIC
      : dotEnvValues.CINETRACK_DATA_REPO_IS_PUBLIC !== undefined
        ? dotEnvValues.CINETRACK_DATA_REPO_IS_PUBLIC
        : null;

  const isPublicRepo = parseOptionalBool(pickRaw('CINETRACK_DATA_REPO_IS_PUBLIC')) === true;
  const allowPublicPersonalSync = parseOptionalBool(
    pickRaw('CINETRACK_ALLOW_PUBLIC_PERSONAL_SYNC')
  );
  const allowPublicCatalogSync = parseOptionalBool(
    pickRaw('CINETRACK_ALLOW_PUBLIC_CATALOG_SYNC')
  );

  return {
    port,
    defaultLoopbackHost,
    explicitHost,
    listenHost,
    effectiveBindHost,
    isRemoteHostWithoutToken,
    tmdbApiKey,
    authToken,
    ...(suggestedAuthToken ? { suggestedAuthToken } : {}),
    trustProxy,
    tmdbRateLimit,
    tmdbRateWindowMs,
    githubToken,
    githubTokenSource,
    githubOwner,
    githubRepo,
    githubBranch,
    isPublicRepo,
    allowPublicPersonalSync,
    allowPublicCatalogSync,
    processEnvIsPublicRepo,
    localEnvIsPublicRepo,
    warnings,
  };
}
