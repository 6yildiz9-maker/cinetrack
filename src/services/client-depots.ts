import { get, set, del, createStore, type UseStore } from 'idb-keyval';
import type { TmdbPersonCreditItem } from '../types/tmdb.ts';
import type { ActorFetchStatus } from '../core/cinetrack-core.ts';

export interface IdbWriteResult {
  persisted: boolean;
  error?: string;
}

// Quota & Persistence Discipline (FEAT-02 Section 4.5 / BUG-02 pattern across ALL depots)
let unpersistedDepotKeys = new Set<string>();
let lastDepotWriteError: string | null = null;
let forceWriteFailureForTests = false;
const quotaWarningListeners = new Set<(hasWarning: boolean, error: string | null) => void>();

function notifyQuotaWarningListeners(): void {
  const hasWarn = unpersistedDepotKeys.size > 0;
  for (const listener of quotaWarningListeners) {
    try {
      listener(hasWarn, lastDepotWriteError);
    } catch {
      // Ignore listener errors
    }
  }
}

export function recordDepotWriteOutcome(
  depotCompositeKey: string,
  persisted: boolean,
  error?: string
): IdbWriteResult {
  if (persisted) {
    if (unpersistedDepotKeys.delete(depotCompositeKey) && unpersistedDepotKeys.size === 0) {
      lastDepotWriteError = null;
      notifyQuotaWarningListeners();
    }
    return { persisted: true };
  }
  const errMsg = error || 'IndexedDB yazma işlemi başarısız oldu';
  unpersistedDepotKeys.add(depotCompositeKey);
  lastDepotWriteError = errMsg;
  notifyQuotaWarningListeners();
  return { persisted: false, error: errMsg };
}

export function hasUnpersistedIdbFallback(): boolean {
  return unpersistedDepotKeys.size > 0;
}

export function isDepotKeyUnpersisted(depotCompositeKey: string): boolean {
  return unpersistedDepotKeys.has(depotCompositeKey);
}

export function getLastIdbQuotaError(): string | null {
  return lastDepotWriteError;
}

export function subscribeIdbQuotaWarning(
  listener: (hasWarning: boolean, error: string | null) => void
): () => void {
  quotaWarningListeners.add(listener);
  return () => {
    quotaWarningListeners.delete(listener);
  };
}

export function setForceIdbWriteFailureForTests(forceFail: boolean): void {
  forceWriteFailureForTests = forceFail;
}

export function isForceIdbWriteFailureActive(): boolean {
  return forceWriteFailureForTests;
}

const isIdbReady = (): boolean => typeof indexedDB !== 'undefined';

let skipLogStore: UseStore | undefined;
let uiPrefsStore: UseStore | undefined;
let actorCreditsStore: UseStore | undefined;

function getExtraDepotStore(
  name: 'ct_skip_log' | 'ct_ui_prefs' | 'ct_actor_credits'
): UseStore | undefined {
  if (!isIdbReady()) return undefined;
  switch (name) {
    case 'ct_skip_log':
      if (!skipLogStore) skipLogStore = createStore('cinetrack-skip-log-db', 'ct_skip_log');
      return skipLogStore;
    case 'ct_ui_prefs':
      if (!uiPrefsStore) uiPrefsStore = createStore('cinetrack-ui-prefs-db', 'ct_ui_prefs');
      return uiPrefsStore;
    case 'ct_actor_credits':
      if (!actorCreditsStore) {
        actorCreditsStore = createStore('cinetrack-actor-credits-db', 'ct_actor_credits');
      }
      return actorCreditsStore;
  }
}

const extraMemoryFallback = new Map<string, unknown>();

async function depotGet<T>(
  storeName: 'ct_skip_log' | 'ct_ui_prefs' | 'ct_actor_credits',
  key: string
): Promise<T | null> {
  const composite = `${storeName}:${key}`;
  if (unpersistedDepotKeys.has(composite) && extraMemoryFallback.has(composite)) {
    return extraMemoryFallback.get(composite) as T;
  }
  const store = getExtraDepotStore(storeName);
  if (store) {
    try {
      const val = await get<T>(key, store);
      if (val !== undefined) {
        extraMemoryFallback.set(composite, val);
        return val;
      }
      return null;
    } catch (err) {
      console.warn(`[IDB] Read failed for ${composite}:`, err);
    }
  }
  const mem = extraMemoryFallback.get(composite);
  return mem !== undefined ? (mem as T) : null;
}

async function depotSet<T>(
  storeName: 'ct_skip_log' | 'ct_ui_prefs' | 'ct_actor_credits',
  key: string,
  value: T
): Promise<IdbWriteResult> {
  const composite = `${storeName}:${key}`;
  extraMemoryFallback.set(composite, value);

  if (forceWriteFailureForTests) {
    return recordDepotWriteOutcome(composite, false, 'Simulated QuotaExceededError');
  }

  const store = getExtraDepotStore(storeName);
  if (store) {
    try {
      await set(key, value, store);
      return recordDepotWriteOutcome(composite, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[IDB] Write failed for ${composite}:`, err);
      return recordDepotWriteOutcome(composite, false, msg);
    }
  }

  // Fallback for Node test environments without indexedDB: mark in-memory only without triggering browser quota banner unless localStorage fails
  if (typeof window !== 'undefined') {
    return recordDepotWriteOutcome(composite, false, 'IndexedDB kullanılamıyor');
  }
  return { persisted: true };
}

async function depotDel(
  storeName: 'ct_skip_log' | 'ct_ui_prefs' | 'ct_actor_credits',
  key: string
): Promise<IdbWriteResult> {
  const composite = `${storeName}:${key}`;
  extraMemoryFallback.delete(composite);
  if (forceWriteFailureForTests) {
    return recordDepotWriteOutcome(composite, false, 'Simulated QuotaExceededError');
  }
  const store = getExtraDepotStore(storeName);
  if (store) {
    try {
      await del(key, store);
      return recordDepotWriteOutcome(composite, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[IDB] Delete failed for ${composite}:`, err);
      return recordDepotWriteOutcome(composite, false, msg);
    }
  }
  return { persisted: true };
}

// ==========================================
// Depo 9: ct:skip-log (Geçici Atlama + Cooldown, Tavan 500)
// ==========================================
export const SKIP_LOG_MAX_SIZE = 500;
export const SKIP_LOG_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün

export interface SkipLogEntry {
  key: string;
  skippedAt: number;
  count: number;
}

export async function loadSkipLogIdb(profileId: string): Promise<SkipLogEntry[]> {
  const raw = await depotGet<SkipLogEntry[]>('ct_skip_log', `skip:${profileId}`);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is SkipLogEntry =>
      Boolean(entry && typeof entry.key === 'string' && typeof entry.skippedAt === 'number')
  );
}

export async function getActiveSkippedKeys(
  profileId: string,
  cooldownMs: number = SKIP_LOG_COOLDOWN_MS,
  nowMs: number = Date.now()
): Promise<Set<string>> {
  const entries = await loadSkipLogIdb(profileId);
  const active = new Set<string>();
  for (const entry of entries) {
    if (nowMs - entry.skippedAt < cooldownMs) {
      active.add(entry.key);
    }
  }
  return active;
}

export async function recordSkippedKeysIdb(
  profileId: string,
  keys: string[],
  options: { maxSize?: number; nowMs?: number } = {}
): Promise<IdbWriteResult & { entries: SkipLogEntry[] }> {
  const maxCap = Math.max(1, Math.floor(options.maxSize ?? SKIP_LOG_MAX_SIZE));
  const nowMs = options.nowMs ?? Date.now();
  const current = await loadSkipLogIdb(profileId);
  const byKey = new Map<string, SkipLogEntry>();
  for (const entry of current) {
    byKey.set(entry.key, entry);
  }

  for (const rawKey of keys) {
    const k = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!k) continue;
    const prev = byKey.get(k);
    // Re-insert so refreshed skips move to the tail (FIFO order by skippedAt)
    if (prev) byKey.delete(k);
    byKey.set(k, {
      key: k,
      skippedAt: nowMs,
      count: (prev?.count || 0) + 1,
    });
  }

  let nextEntries = Array.from(byKey.values());
  if (nextEntries.length > maxCap) {
    nextEntries = nextEntries.slice(nextEntries.length - maxCap);
  }

  const writeRes = await depotSet('ct_skip_log', `skip:${profileId}`, nextEntries);
  return { ...writeRes, entries: nextEntries };
}

export async function removeSkippedKeyIdb(
  profileId: string,
  mediaKey: string
): Promise<IdbWriteResult> {
  if (!mediaKey) return { persisted: true };
  const current = await loadSkipLogIdb(profileId);
  const filtered = current.filter((e) => e.key !== mediaKey);
  if (filtered.length === current.length) return { persisted: true };
  return depotSet('ct_skip_log', `skip:${profileId}`, filtered);
}

// ==========================================
// Depo 10: ct:ui-prefs (Tümü/Film/Dizi + Sıralama + Tür Tercihi)
// ==========================================
export interface UiPrefsRecord {
  profileId: string;
  selectedType: 'all' | 'movie' | 'tv';
  selectedSort: string;
  selectedGenre: string;
  hideListedItems: boolean;
  forYouSubTab: 'recommendations' | 'series';
  updatedAt: string;
}

export async function loadUiPrefsIdb(profileId: string): Promise<UiPrefsRecord | null> {
  const raw = await depotGet<UiPrefsRecord>('ct_ui_prefs', `ui_prefs:${profileId}`);
  if (!raw || typeof raw !== 'object') return null;
  const selectedType: 'all' | 'movie' | 'tv' =
    raw.selectedType === 'movie' || raw.selectedType === 'tv' ? raw.selectedType : 'all';
  const forYouSubTab: 'recommendations' | 'series' =
    raw.forYouSubTab === 'series' ? 'series' : 'recommendations';
  return {
    profileId,
    selectedType,
    selectedSort: typeof raw.selectedSort === 'string' && raw.selectedSort ? raw.selectedSort : 'popular',
    selectedGenre: typeof raw.selectedGenre === 'string' ? raw.selectedGenre : '',
    hideListedItems: Boolean(raw.hideListedItems),
    forYouSubTab,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

export async function saveUiPrefsIdb(prefs: UiPrefsRecord): Promise<IdbWriteResult> {
  const normalized: UiPrefsRecord = {
    profileId: prefs.profileId,
    selectedType:
      prefs.selectedType === 'movie' || prefs.selectedType === 'tv' ? prefs.selectedType : 'all',
    selectedSort: prefs.selectedSort || 'popular',
    selectedGenre: prefs.selectedGenre || '',
    hideListedItems: Boolean(prefs.hideListedItems),
    forYouSubTab: prefs.forYouSubTab === 'series' ? 'series' : 'recommendations',
    updatedAt: prefs.updatedAt || new Date().toISOString(),
  };
  return depotSet('ct_ui_prefs', `ui_prefs:${prefs.profileId}`, normalized);
}

// ==========================================
// Depo 12: ct:actor-credits:{actorId} (~7 Gün TTL)
// ==========================================
export const ACTOR_CREDITS_DEPOT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün

export interface ActorCreditsDepotRecord {
  actorId: number;
  credits: TmdbPersonCreditItem[];
  status: ActorFetchStatus;
  cachedAt: number;
}

export function makeActorCreditsDepotKey(actorId: number): string {
  return `ct:actor-credits:${actorId}`;
}

export async function loadActorCreditsIdb(
  actorId: number,
  options: { allowStale?: boolean; ttlMs?: number; nowMs?: number } = {}
): Promise<ActorCreditsDepotRecord | null> {
  if (!Number.isInteger(actorId) || actorId <= 0) return null;
  const key = makeActorCreditsDepotKey(actorId);
  const record = await depotGet<ActorCreditsDepotRecord>('ct_actor_credits', key);
  if (!record || !Array.isArray(record.credits) || typeof record.cachedAt !== 'number') {
    return null;
  }
  const ttlMs = options.ttlMs ?? ACTOR_CREDITS_DEPOT_TTL_MS;
  const nowMs = options.nowMs ?? Date.now();
  const isFresh = nowMs - record.cachedAt < ttlMs;
  if (!isFresh && !options.allowStale) {
    return null;
  }
  return record;
}

export async function saveActorCreditsIdb(
  actorId: number,
  credits: TmdbPersonCreditItem[],
  status: ActorFetchStatus,
  nowMs: number = Date.now()
): Promise<IdbWriteResult> {
  if (!Number.isInteger(actorId) || actorId <= 0) {
    return { persisted: false, error: 'Geçersiz actorId' };
  }
  const key = makeActorCreditsDepotKey(actorId);
  const payload: ActorCreditsDepotRecord = {
    actorId,
    credits: Array.isArray(credits) ? credits : [],
    status,
    cachedAt: nowMs,
  };
  return depotSet('ct_actor_credits', key, payload);
}

export async function clearActorCreditsIdb(actorId: number): Promise<IdbWriteResult> {
  return depotDel('ct_actor_credits', makeActorCreditsDepotKey(actorId));
}

export function resetClientDepotsForTests(): void {
  skipLogStore = undefined;
  uiPrefsStore = undefined;
  actorCreditsStore = undefined;
  extraMemoryFallback.clear();
  unpersistedDepotKeys = new Set();
  lastDepotWriteError = null;
  forceWriteFailureForTests = false;
  notifyQuotaWarningListeners();
}
