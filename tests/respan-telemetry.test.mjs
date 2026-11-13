import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRespanTracing,
  DEFAULT_RESPAN_BASE_URL,
  RESPAN_APP_NAME,
} from '../src/server/respan-telemetry.ts';

function createSilentLogger() {
  const lines = [];
  return {
    lines,
    info: (msg) => lines.push(['info', String(msg)]),
    warn: (msg) => lines.push(['warn', String(msg)]),
  };
}

function createFakeClient(statuses = [{ id: 'openai', status: 'enabled' }]) {
  const calls = { initialize: 0, configs: [] };
  return {
    calls,
    client: {
      async initialize() {
        calls.initialize += 1;
      },
      getInstrumentationStatus() {
        return statuses;
      },
    },
  };
}

test('RESPAN_API_KEY yokken izleme devre dışı kalır ve istemci oluşturulmaz', async () => {
  const logger = createSilentLogger();
  let created = 0;
  const summary = await createRespanTracing({
    logger,
    createClient: () => {
      created += 1;
      return createFakeClient().client;
    },
  }).start();

  assert.equal(summary.enabled, false);
  assert.equal(created, 0);
  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0][1], /RESPAN_API_KEY/);
});

test('anahtar varken SDK bir kez başlatılır ve varsayılan baseURL kullanılır', async () => {
  const logger = createSilentLogger();
  const fake = createFakeClient([
    { id: 'openai', status: 'enabled' },
    { id: 'anthropic', status: 'missing' },
    { id: 'cohere', status: 'failed' },
    { id: 'writer', status: 'disabled' },
  ]);
  const respanTracing = createRespanTracing({
    apiKey: 'test-key',
    logger,
    createClient: (config) => {
      fake.calls.configs.push(config);
      return fake.client;
    },
  });

  const first = await respanTracing.start();
  const second = await respanTracing.start();

  assert.equal(first.enabled, true);
  assert.deepEqual(second, first);
  assert.equal(fake.calls.initialize, 1);
  assert.deepEqual(fake.calls.configs, [
    { apiKey: 'test-key', baseURL: DEFAULT_RESPAN_BASE_URL, appName: RESPAN_APP_NAME },
  ]);
  assert.deepEqual(first.instrumentation, { enabled: 1, missing: 1, failed: 1, disabled: 1 });
  assert.equal(
    logger.lines.some(([, msg]) => msg.includes('test-key')),
    false
  );
});

test('RESPAN_BASE_URL verildiğinde kurumsal uç nokta kullanılır', async () => {
  const logger = createSilentLogger();
  const fake = createFakeClient();
  const summary = await createRespanTracing({
    apiKey: 'test-key',
    baseUrl: 'https://endpoint.respan.ai/api',
    logger,
    createClient: (config) => {
      fake.calls.configs.push(config);
      return fake.client;
    },
  }).start();

  assert.equal(summary.baseUrl, 'https://endpoint.respan.ai/api');
  assert.equal(fake.calls.configs[0].baseURL, 'https://endpoint.respan.ai/api');
});

test('SDK başlatma hatası sunucu başlangıcını düşürmez', async () => {
  const logger = createSilentLogger();
  const summary = await createRespanTracing({
    apiKey: 'test-key',
    logger,
    createClient: () => ({
      async initialize() {
        throw new Error('exporter hazır değil');
      },
      getInstrumentationStatus: () => [],
    }),
  }).start();

  assert.equal(summary.enabled, false);
  assert.match(summary.error, /exporter/);
  assert.equal(logger.lines[0][0], 'warn');
});
