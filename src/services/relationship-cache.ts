import type { PoolCandidateItem, SavedItem } from '../core/cinetrack-core';
import type {
  MediaFilter,
  RelationshipGraphData,
  RelationshipMode,
  RelationshipType,
} from '../core/relationship-explorer';

const DB_NAME = 'cinetrack-relationship-cache';
const DB_VERSION = 1;
const STORE_NAMES = ['graphs', 'features', 'edges'] as const;
export type RelationshipCacheStore = (typeof STORE_NAMES)[number];

export interface CacheRecord<T> {
  key: string;
  savedAt: number;
  value: T;
}

export interface RelationshipGraphSnapshot {
  schemaVersion: number;
  profileId: string;
  mode: RelationshipMode;
  mediaFilter: MediaFilter;
  sourceKey: string;
  relationshipFilter: RelationshipType | 'all';
  profileSignature: string;
  poolSignature: string;
  modelVersion: string;
  savedAt: number;
  graph: RelationshipGraphData;
  // Sadece grafikte bulunan içerikler saklanır; tüm aday havuzu kopyalanmaz.
  visibleItems: Array<PoolCandidateItem | SavedItem>;
}

function openRelationshipDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB bu ortamda kullanılamıyor.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of STORE_NAMES) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'key' });
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('İlişki önbelleği açılamadı.'));
    request.onblocked = () =>
      reject(new Error('İlişki önbelleği güncellemesi başka bir sekme tarafından engellendi.'));
  });
}

export async function readRelationshipCache<T>(
  storeName: RelationshipCacheStore,
  key: string,
): Promise<CacheRecord<T> | null> {
  const db = await openRelationshipDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result as CacheRecord<T> | undefined) || null);
      request.onerror = () => reject(request.error || new Error('Önbellek kaydı okunamadı.'));
      tx.onabort = () => reject(tx.error || new Error('Önbellek okuma işlemi iptal edildi.'));
    });
  } finally {
    db.close();
  }
}

export async function writeRelationshipCache<T>(
  storeName: RelationshipCacheStore,
  key: string,
  value: T,
): Promise<void> {
  const db = await openRelationshipDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put({ key, savedAt: Date.now(), value } satisfies CacheRecord<T>);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Önbellek yazılamadı.'));
      tx.onabort = () => reject(tx.error || new Error('Önbellek yazma işlemi iptal edildi.'));
    });
  } finally {
    db.close();
  }
}

export async function deleteRelationshipCache(
  storeName: RelationshipCacheStore,
  key: string,
): Promise<void> {
  const db = await openRelationshipDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Önbellek kaydı silinemedi.'));
      tx.onabort = () => reject(tx.error || new Error('Önbellek silme işlemi iptal edildi.'));
    });
  } finally {
    db.close();
  }
}

export function latestGraphCacheKey(profileId: string, mode: RelationshipMode): string {
  return `latest:${profileId}:${mode}`;
}

export function graphCacheKey(args: {
  profileId: string;
  mode: RelationshipMode;
  mediaFilter: MediaFilter;
  sourceKey: string;
  relationshipFilter: RelationshipType | 'all';
  profileSignature: string;
  poolSignature: string;
  modelVersion: string;
}): string {
  // Anahtar kısa tutulur; ayrıntılı imzalar kayıt içinde doğrulanmaya devam eder.
  return [
    'graph',
    args.profileId,
    args.mode,
    args.mediaFilter,
    args.sourceKey || 'no-source',
    args.relationshipFilter,
    args.profileSignature.split(':').pop() || '0',
    args.poolSignature,
    args.modelVersion,
  ].join(':');
}

export function relationshipEdgeCacheKey(args: {
  sourceKey: string;
  targetKey: string;
  sourceFeatureHash: string;
  targetFeatureHash: string;
  modelVersion: string;
}): string {
  // Şimdiki semantic/person/universe ilişkileri yönsüzdür; çift kimliklerini kanonik sıraya koy.
  const pair = [
    { key: args.sourceKey, hash: args.sourceFeatureHash },
    { key: args.targetKey, hash: args.targetFeatureHash },
  ].sort((a, b) => a.key.localeCompare(b.key));
  return [
    'edge',
    args.modelVersion,
    encodeURIComponent(pair[0].key),
    pair[0].hash,
    encodeURIComponent(pair[1].key),
    pair[1].hash,
  ].join(':');
}
