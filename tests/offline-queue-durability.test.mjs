import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFLINE_QUEUE_MAX_ATTEMPTS,
  clearOfflineSyncSnapshot,
  enqueueOfflineSyncSnapshotDurable,
  loadOfflineSyncSnapshot,
  offlineQueueBackoffMs,
  recordOfflineQueueAttempt,
  resetOfflineQueueForTests,
} from '../src/services/offline-queue.ts';

function installLocalStorageMock() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  };
  return map;
}

const DOC = {
  version: 3,
  schemaVersion: 3,
  engineVersion: 'test',
  activeProfileId: 'profile-a',
  profiles: [{ id: 'profile-a', name: 'A', createdAt: '', preferences: {}, items: [] }],
  revision: 7,
  updatedAt: new Date().toISOString(),
};

test('SEC-04: üstel geri çekilme 2 sn ile başlar ve 5 dk tavanına oturur', () => {
  assert.equal(offlineQueueBackoffMs(0), 0);
  assert.equal(offlineQueueBackoffMs(1), 2_000);
  assert.equal(offlineQueueBackoffMs(2), 4_000);
  assert.equal(offlineQueueBackoffMs(3), 8_000);
  assert.equal(offlineQueueBackoffMs(12), 5 * 60_000, 'tavan 5 dakika');
});

test('DATA-01: kuyruk yazımı kalıcılığı doğrulanır ve deneme sayacı birikir', async () => {
  installLocalStorageMock();
  resetOfflineQueueForTests();

  const enq = await enqueueOfflineSyncSnapshotDurable(DOC, 7);
  assert.equal(enq.persisted, true, 'yazma tamamlanmadan başarı denmez');
  assert.equal(enq.storage, 'localstorage');
  assert.ok(loadOfflineSyncSnapshot()?.payload, 'geri okunabilir kayıt var');

  const first = await recordOfflineQueueAttempt();
  assert.equal(first.attempts, 1);
  assert.equal(first.nextDelayMs, 2_000);
  assert.equal(first.exhausted, false);

  const second = await recordOfflineQueueAttempt();
  assert.equal(second.attempts, 2);
  assert.equal(second.nextDelayMs, 4_000);
  assert.equal(loadOfflineSyncSnapshot()?.attempts, 2, 'sayaç kalıcı');

  await clearOfflineSyncSnapshot();
  assert.equal(loadOfflineSyncSnapshot(), null, 'temizleme kalıcı kaydı siler');
  resetOfflineQueueForTests();
});

test('SEC-04: deneme sınırı aşıldığında exhausted işaretlenir', async () => {
  installLocalStorageMock();
  resetOfflineQueueForTests();
  await enqueueOfflineSyncSnapshotDurable(DOC, 0);

  let last = null;
  for (let i = 0; i < OFFLINE_QUEUE_MAX_ATTEMPTS; i += 1) {
    last = await recordOfflineQueueAttempt();
  }
  assert.equal(last.attempts, OFFLINE_QUEUE_MAX_ATTEMPTS);
  assert.equal(last.exhausted, true);
  assert.equal(last.nextDelayMs, 0, 'tükenince otomatik deneme durur');
  await clearOfflineSyncSnapshot();
  resetOfflineQueueForTests();
});
