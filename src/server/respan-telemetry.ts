import type { InstrumentationStatusEntry } from '@respan/respan';

/**
 * Respan izleme (tracing) entegrasyonu — sunucu katmanı.
 *
 * `@respan/respan` resmi kurulum kuralı: SDK, ilk model çağrısından ÖNCE bir kez
 * başlatılır (`await respan.initialize()`); ardından OpenAI / Anthropic / Bedrock
 * gibi sağlayıcı SDK'ları otomatik olarak izlenir. Bu modül söz konusu tek
 * başlatma noktasını sağlar ve `RESPAN_API_KEY` tanımlı değilse hiçbir şey
 * yapmadan devre dışı kalır; uygulama izleme olmadan normal çalışmaya devam eder.
 *
 * Anahtar yalnızca sunucu tarafında okunur ve hiçbir koşulda loglanmaz.
 */

export const DEFAULT_RESPAN_BASE_URL = 'https://api.respan.ai/api';
export const RESPAN_APP_NAME = 'cinethos';

export interface RespanClientConfig {
  apiKey: string;
  baseURL: string;
  appName: string;
}

/** Test edilebilirlik için SDK yüzeyinin kullanılan alt kümesi. */
export interface RespanClientLike {
  initialize(): Promise<void>;
  getInstrumentationStatus(): InstrumentationStatusEntry[];
}

export interface RespanTracingOptions {
  apiKey?: string;
  baseUrl?: string;
  appName?: string;
  logger?: Pick<Console, 'info' | 'warn'>;
  createClient?: (config: RespanClientConfig) => RespanClientLike | Promise<RespanClientLike>;
}

export interface RespanInstrumentationCounts {
  enabled: number;
  missing: number;
  failed: number;
  disabled: number;
}

export interface RespanTracingSummary {
  enabled: boolean;
  baseUrl?: string;
  instrumentation?: RespanInstrumentationCounts;
  error?: string;
}

export interface RespanTracing {
  /** İzlemeyi bir kez başlatır; tekrarlanan çağrılar aynı sonucu döndürür. */
  start(): Promise<RespanTracingSummary>;
}

async function createDefaultClient(config: RespanClientConfig): Promise<RespanClientLike> {
  // SDK yalnızca anahtar mevcutken yüklenir; uygulama anahtarsızken ek yük getirmez.
  const { Respan } = await import('@respan/respan');
  return new Respan(config);
}

function countInstrumentationStatuses(
  statuses: InstrumentationStatusEntry[]
): RespanInstrumentationCounts {
  const counts: RespanInstrumentationCounts = { enabled: 0, missing: 0, failed: 0, disabled: 0 };
  for (const entry of statuses) {
    if (entry.status === 'enabled') counts.enabled += 1;
    else if (entry.status === 'missing') counts.missing += 1;
    else if (entry.status === 'failed') counts.failed += 1;
    else counts.disabled += 1;
  }
  return counts;
}

async function startRespanTracing(options: RespanTracingOptions): Promise<RespanTracingSummary> {
  const logger = options.logger ?? console;
  const apiKey = (options.apiKey ?? '').trim();
  if (!apiKey) {
    logger.info(
      '[Respan] RESPAN_API_KEY tanımlı değil; LLM izleme devre dışı (uygulama normal çalışır).'
    );
    return { enabled: false };
  }

  const baseUrl = (options.baseUrl ?? '').trim() || DEFAULT_RESPAN_BASE_URL;
  const appName = (options.appName ?? '').trim() || RESPAN_APP_NAME;

  try {
    const createClient = options.createClient ?? createDefaultClient;
    const client = await createClient({ apiKey, baseURL: baseUrl, appName });
    await client.initialize();

    const statuses = client.getInstrumentationStatus();
    const instrumentation = countInstrumentationStatuses(statuses);
    logger.info(
      `[Respan] İzleme başlatıldı (baseURL: ${baseUrl}, aktif adaptör: ${instrumentation.enabled}/${statuses.length}).`
    );
    if (statuses.length > 0 && instrumentation.enabled === 0) {
      logger.info(
        '[Respan] Kurulu bir LLM SDK adaptörü bulunamadı; uygulamaya model çağrısı eklendiğinde span\'lar otomatik gönderilir.'
      );
    }

    return { enabled: true, baseUrl, instrumentation };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[Respan] İzleme başlatılamadı (${message}); uygulama izleme olmadan devam ediyor.`
    );
    return { enabled: false, baseUrl, error: message };
  }
}

export function createRespanTracing(options: RespanTracingOptions = {}): RespanTracing {
  let started: Promise<RespanTracingSummary> | null = null;
  return {
    start(): Promise<RespanTracingSummary> {
      if (!started) {
        started = startRespanTracing(options);
      }
      return started;
    },
  };
}
