/**
 * İstemci taraflı API yardımcıları (SEC-02, SEC-03).
 *
 * - `ApiError`: HTTP durumunu ve sunucu `code`'unu koruyan tek hata tipi.
 *   Böylece 401/503/ağ hatası birbirinden ayrılabilir (tek `null` dönüşü yerine).
 * - LAN/uzak modda sunucu `CINETRACK_TOKEN` ister; istemci tokenı yalnızca
 *   `sessionStorage`'da tutar, `localStorage`'a yazılmaz.
 * - 401/503 yanıtında `cinetrack:auth-required` olayı yayınlanır; App token
 *   istemini gösterir.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 503;
  }

  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const CLIENT_TOKEN_KEY = 'cinetrack_client_token_v1';
export const AUTH_REQUIRED_EVENT = 'cinetrack:auth-required';

export function getClientAuthToken(): string {
  try {
    return sessionStorage.getItem(CLIENT_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setClientAuthToken(token: string): void {
  try {
    const clean = token.trim();
    if (clean) sessionStorage.setItem(CLIENT_TOKEN_KEY, clean);
    else sessionStorage.removeItem(CLIENT_TOKEN_KEY);
  } catch {
    /* oturum deposu kapalıysa token yalnızca bellekte tutulamaz */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cinetrack:auth-token-changed'));
  }
}

export function clearClientAuthToken(): void {
  setClientAuthToken('');
}

function withClientAuth(headers: HeadersInit | undefined): HeadersInit {
  const token = getClientAuthToken();
  if (headers instanceof Headers) {
    const merged = new Headers(headers);
    if (token && !merged.has('X-CineTrack-Token')) merged.set('X-CineTrack-Token', token);
    return merged;
  }
  if (Array.isArray(headers)) {
    const merged = new Map(headers as Array<[string, string]>);
    if (token && !merged.has('X-CineTrack-Token')) merged.set('X-CineTrack-Token', token);
    return Array.from(merged.entries());
  }
  // Düz nesne biçimini koru: çağıranlar ve testler başlıkları `obj['If-Match']` gibi okuyor.
  const plain: Record<string, string> = { ...((headers as Record<string, string>) || {}) };
  if (token && !('X-CineTrack-Token' in plain)) plain['X-CineTrack-Token'] = token;
  return plain;
}

/** 401/503'te kullanıcıya token istemi göstermek için olay yayınlar. */
export function notifyAuthRequired(status: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, { detail: { status } }));
}

/**
 * `fetch` sarmalayıcısı: token ekler ve kimlik hatasını tek yerden bildirir.
 * Çağıranlar `response.ok` kontrolünü korur; ağ hatası `ApiError(0)` olarak döner.
 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, { ...init, headers: withClientAuth(init.headers) });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(
      'Yerel CineTrack sunucusuna ulaşılamadı. Sunucunun çalıştığını doğrulayın.',
      0
    );
  }
  if (response.status === 401 || response.status === 503) {
    notifyAuthRequired(response.status);
  }
  return response;
}

/** Hata gövdesinden okunabilir mesaj + `code` çıkarır. */
export async function readApiErrorMessage(
  response: Response,
  fallback: string
): Promise<{ message: string; code?: string }> {
  try {
    const body = await response.json();
    return {
      message: String(body?.status_message || body?.error || fallback),
      code: typeof body?.code === 'string' ? body.code : undefined,
    };
  } catch {
    return { message: fallback };
  }
}
