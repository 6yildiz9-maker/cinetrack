import { ENCODING_LAYOUT_VERSION } from '../core/encoding.ts';
import { RELATIONSHIP_GRAPH_SCHEMA_VERSION } from '../core/relationship-explorer.ts';
import { clearAllEncodingsCache } from './encoding-service.ts';
import { clearAllRelationshipCache } from './relationship-cache.ts';

/**
 * IMP-17 + REG-02 + REG-03:
 * Merkezi IndexedDB depo şema sürüm kaydı ve tek seferlik güvenli göç/temizlik katmanı.
 * Türetilmiş önbelleklerin (ct:encodings, ct:graph-cache) şeması değiştiğinde otomatik sıfırlanır;
 * kullanıcı profili, izleme listeleri ve yerel katalog stoku (ct:stock) her zaman korunur.
 */
export const SCHEMA_VERSION = 2;

export const IDB_DEPOT_SCHEMA_VERSIONS = {
  ct_encodings: ENCODING_LAYOUT_VERSION,
  ct_relationship_cache: RELATIONSHIP_GRAPH_SCHEMA_VERSION,
  ct_stock: 1,
  ct_surfaced: 1,
  ct_series_index: 1,
  ct_user_lists: 1,
  ct_profile: 1,
  ct_offline_queue: 1,
  ct_skip_log: 1,
  ct_ui_prefs: 1,
  ct_actor_credits: 1,
} as const;

export type IdbDepotKey = keyof typeof IDB_DEPOT_SCHEMA_VERSIONS;
export type StoredDepotVersions = Partial<Record<IdbDepotKey, number>> & {
  schemaVersion?: number;
  updatedAt?: string;
};

export const IDB_SCHEMA_STORAGE_KEY = 'cinetrack_idb_depot_versions_v1';

let memoryFallbackVersions: StoredDepotVersions | null = null;
let migrationPromise: Promise<IdbMigrationReport> | null = null;

export interface IdbMigrationReport {
  schemaVersion: number;
  migratedDepots: IdbDepotKey[];
  preservedDepots: IdbDepotKey[];
  completedAt: string;
}

export interface DerivedCacheResetReport {
  ok: boolean;
  clearedDepots: string[];
  preservedDepots: string[];
  resetAt: string;
}

export function readStoredDepotSchemaVersions(): StoredDepotVersions {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(IDB_SCHEMA_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') {
          return parsed as StoredDepotVersions;
        }
      }
      return {};
    }
  } catch {
    // Fall back to in-memory map if localStorage is blocked
  }
  return memoryFallbackVersions ? { ...memoryFallbackVersions } : {};
}

export function writeStoredDepotSchemaVersions(versions: StoredDepotVersions): void {
  const payload: StoredDepotVersions = {
    ...versions,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  memoryFallbackVersions = payload;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(IDB_SCHEMA_STORAGE_KEY, JSON.stringify(payload));
    }
  } catch {
    // Ignore quota/security exceptions; in-memory state remains updated
  }
}

function buildCurrentDepotVersionSnapshot(): StoredDepotVersions {
  return {
    ...IDB_DEPOT_SCHEMA_VERSIONS,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Uygulama açılışında bir kez çalışır.
 * Yalnızca sürümü geride kalmış türetilmiş önbellek depolarını temizler.
 */
export async function runIdbSchemaMigrationsOnce(): Promise<IdbMigrationReport> {
  if (migrationPromise) {
    return migrationPromise;
  }

  migrationPromise = (async (): Promise<IdbMigrationReport> => {
    const stored = readStoredDepotSchemaVersions();
    const migratedDepots: IdbDepotKey[] = [];
    const preservedDepots: IdbDepotKey[] = [
      'ct_stock',
      'ct_profile',
      'ct_user_lists',
      'ct_series_index',
      'ct_surfaced',
      'ct_offline_queue',
      'ct_skip_log',
      'ct_ui_prefs',
      'ct_actor_credits',
    ];

    const storedEncVersion = Number(stored.ct_encodings ?? 0);
    if (storedEncVersion < IDB_DEPOT_SCHEMA_VERSIONS.ct_encodings) {
      await clearAllEncodingsCache();
      migratedDepots.push('ct_encodings');
    }

    const storedGraphVersion = Number(stored.ct_relationship_cache ?? 0);
    if (storedGraphVersion < IDB_DEPOT_SCHEMA_VERSIONS.ct_relationship_cache) {
      await clearAllRelationshipCache();
      migratedDepots.push('ct_relationship_cache');
    }

    writeStoredDepotSchemaVersions(buildCurrentDepotVersionSnapshot());

    const completedAt = new Date().toISOString();
    if (migratedDepots.length > 0) {
      console.info('[Cinethos IDB Schema] Eski önbellek depoları yeni şemaya geçirildi:', {
        schemaVersion: SCHEMA_VERSION,
        migratedDepots,
      });
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      migratedDepots,
      preservedDepots,
      completedAt,
    };
  })();

  return migrationPromise;
}

/**
 * REG-03 + IMP-18: Ayarlar menüsü veya Hata Kartı üzerinden tetiklenen manuel önbellek sıfırlama.
 * `ct:encodings` ve `cinetrack-relationship-cache` depolarını tamamen temizler;
 * kullanıcı profili, izleme listeleri ve `ct:stock` yerel katalog havuzuna kesinlikle dokunmaz.
 */
export async function resetDerivedCachesPreserveProfileAndStock(): Promise<DerivedCacheResetReport> {
  const [encRes, graphCleared] = await Promise.all([
    clearAllEncodingsCache(),
    clearAllRelationshipCache(),
  ]);

  writeStoredDepotSchemaVersions(buildCurrentDepotVersionSnapshot());

  const resetAt = new Date().toISOString();
  return {
    ok: Boolean(encRes.cleared && graphCleared),
    clearedDepots: ['ct:encodings', 'cinetrack-relationship-cache'],
    preservedDepots: ['ct:profile', 'ct:user-lists', 'ct:stock', 'ct:series-index'],
    resetAt,
  };
}

export function resetSchemaMigrationStateForTests(): void {
  migrationPromise = null;
  memoryFallbackVersions = null;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(IDB_SCHEMA_STORAGE_KEY);
    }
  } catch {}
}
