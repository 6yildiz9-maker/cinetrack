/* CineTrack Service Worker Poster Cache Manager (EXT-03)
 * Enforces a strict 200 MiB (209,715,200 bytes) maximum quota on cached TMDB posters
 * with automatic Least-Recently-Used (LRU) eviction.
 */
(function () {
  const POSTER_CACHE_NAME = 'cinetrack-tmdb-posters';
  const MAX_POSTER_CACHE_BYTES = 200 * 1024 * 1024; // 200 MiB
  const TARGET_POSTER_CACHE_BYTES = 160 * 1024 * 1024; // 160 MiB post-purge target
  const DB_NAME = 'cinetrack-sw-poster-meta';
  const STORE_NAME = 'poster_lru';

  let purgeInFlight = false;
  let accessCounter = 0;

  function isPosterUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    return (
      rawUrl.includes('image.tmdb.org/') ||
      rawUrl.includes('img.tmdb.org/') ||
      rawUrl.includes('/api/tmdb-image')
    );
  }

  function openLruDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'url' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function touchPosterEntry(url, sizeHint) {
    try {
      const db = await openLruDb();
      if (!db) return;
      await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(url);
        getReq.onsuccess = () => {
          const prev = getReq.result;
          store.put({
            url,
            lastAccessed: Date.now(),
            size: typeof sizeHint === 'number' && sizeHint > 0 ? sizeHint : (prev && prev.size) || 0,
          });
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
      db.close();
    } catch (_) {}
  }

  async function readAllLruMeta() {
    const map = new Map();
    try {
      const db = await openLruDb();
      if (!db) return map;
      await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const rows = Array.isArray(req.result) ? req.result : [];
          for (const row of rows) {
            if (row && row.url) map.set(row.url, row);
          }
          resolve(true);
        };
        req.onerror = () => resolve(false);
      });
      db.close();
    } catch (_) {}
    return map;
  }

  async function removeLruMetaUrls(urls) {
    if (!urls || urls.length === 0) return;
    try {
      const db = await openLruDb();
      if (!db) return;
      await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const u of urls) {
          store.delete(u);
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
      db.close();
    } catch (_) {}
  }

  async function measureResponseBytes(res, metaEntry) {
    if (metaEntry && typeof metaEntry.size === 'number' && metaEntry.size > 0) {
      return metaEntry.size;
    }
    const cl = res.headers && res.headers.get('content-length');
    if (cl && Number(cl) > 0) {
      return Number(cl);
    }
    if (res.type !== 'opaque') {
      try {
        const blob = await res.clone().blob();
        if (blob && blob.size > 0) return blob.size;
      } catch (_) {}
    }
    return 48 * 1024; // Conservative fallback for opaque responses (~48 KiB)
  }

  async function purgePosterCacheIfNeeded() {
    if (purgeInFlight || typeof caches === 'undefined') return { purgedCount: 0, freedBytes: 0 };
    purgeInFlight = true;
    try {
      const cache = await caches.open(POSTER_CACHE_NAME);
      const requests = await cache.keys();
      if (requests.length === 0) return { purgedCount: 0, freedBytes: 0 };

      const lruMeta = await readAllLruMeta();
      const entries = [];
      let totalBytes = 0;

      for (let i = 0; i < requests.length; i++) {
        const req = requests[i];
        const res = await cache.match(req);
        if (!res) continue;
        const meta = lruMeta.get(req.url);
        const size = await measureResponseBytes(res, meta);
        const dateHeader = res.headers && res.headers.get('date');
        const headerTime = dateHeader ? new Date(dateHeader).getTime() : 0;
        const lastAccessed =
          meta && typeof meta.lastAccessed === 'number'
            ? meta.lastAccessed
            : Number.isFinite(headerTime) && headerTime > 0
            ? headerTime
            : i;
        totalBytes += size;
        entries.push({ req, url: req.url, size, lastAccessed });
      }

      if (totalBytes <= MAX_POSTER_CACHE_BYTES) {
        return { purgedCount: 0, freedBytes: 0 };
      }

      // Least Recently Used (oldest lastAccessed) evicted first
      entries.sort((a, b) => a.lastAccessed - b.lastAccessed);

      let purgedCount = 0;
      let freedBytes = 0;
      const deletedUrls = [];

      for (const entry of entries) {
        if (totalBytes - freedBytes <= TARGET_POSTER_CACHE_BYTES) break;
        const deleted = await cache.delete(entry.req);
        if (deleted) {
          freedBytes += entry.size;
          purgedCount += 1;
          deletedUrls.push(entry.url);
        }
      }

      await removeLruMetaUrls(deletedUrls);
      return { purgedCount, freedBytes };
    } catch (_) {
      return { purgedCount: 0, freedBytes: 0 };
    } finally {
      purgeInFlight = false;
    }
  }

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (!req || req.method !== 'GET' || !isPosterUrl(req.url)) return;
    accessCounter += 1;
    const shouldCheckQuota = accessCounter % 15 === 0;
    event.waitUntil(
      (async () => {
        await touchPosterEntry(req.url, 0);
        if (shouldCheckQuota) {
          await purgePosterCacheIfNeeded();
        }
      })()
    );
  });

  self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'ENFORCE_POSTER_QUOTA') {
      event.waitUntil(purgePosterCacheIfNeeded());
    }
  });
})();
