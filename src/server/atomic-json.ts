import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

let tempFileSeq = 0;

export class CorruptJsonFileError extends Error {
  public readonly filePath: string;
  public readonly code = 'corrupt_json_file';

  constructor(filePath: string, detail?: string) {
    super(
      `Kalıcı JSON dosyası bozuk ve kurtarılamadı (${path.basename(filePath)})${
        detail ? `: ${detail}` : ''
      }. Mevcut veriyi ezmemek için yazma işlemi durduruldu.`
    );
    this.name = 'CorruptJsonFileError';
    this.filePath = filePath;
  }
}

export interface AtomicWriteOptions {
  backupPath?: string;
  validateParsed?: (parsed: any) => boolean;
  /** Yalnızca birim testlerinde yazma ortası hata simülasyonu için kullanılır */
  beforeRenameHook?: (tempFilePath: string) => void;
}

export interface ReadJsonRecoveryOptions<T> {
  backupPaths?: string[];
  validate?: (raw: any) => T | null;
  label?: string;
  restoreRecoveredToTarget?: boolean;
}

export type ReadJsonRecoveryResult<T> =
  | { status: 'missing'; data: null }
  | { status: 'ok'; data: T }
  | { status: 'recovered'; data: T; recoveredFrom: string }
  | { status: 'corrupt_unrecoverable'; data: null; error: string; quarantinePath?: string };

/**
 * Başlangıçta önceki yarım kalmış süreçlerden kalan `*.tmp` dosyalarını kontrollü temizler.
 * Asla gerçek `.json` veya `.bak` dosyalarını silmez.
 */
export function cleanupStaleTempFiles(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  const removed: string[] = [];
  try {
    const entries = readdirSync(dirPath);
    for (const name of entries) {
      if (!name.endsWith('.tmp') || !name.includes('.json.')) continue;
      const fullPath = path.join(dirPath, name);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          unlinkSync(fullPath);
          removed.push(fullPath);
        }
      } catch {}
    }
  } catch {}
  return removed;
}

/**
 * Bir dosyanın geçerli JSON (ve varsa şema doğrulamasından geçen veri) içerdiğini kontrol eder.
 */
export function tryParseValidJson<T = any>(
  filePath: string,
  validate?: (raw: any) => T | null
): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const text = readFileSync(filePath, 'utf8');
    const raw = JSON.parse(text);
    if (validate) {
      const validated = validate(raw);
      if (validated === null) {
        return { ok: false, error: 'Şema doğrulaması başarısız.' };
      }
      return { ok: true, data: validated };
    }
    return { ok: true, data: raw as T };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'JSON ayrıştırma hatası.' };
  }
}

/**
 * Kalıcı JSON dosyalarını atomik ve güvenli biçimde yazar:
 * 1. Yazılacak metnin geçerli JSON olduğunu doğrular.
 * 2. Mevcut hedef dosya geçerli ise isteğe bağlı `.bak` yedeğini günceller (bozuk dosya sağlam `.bak` yedeğini ezmez).
 * 3. Aynı dizinde benzersiz `.tmp` dosyasına yazar, bayt uzunluğunu doğrular ve `fsyncSync` uygular.
 * 4. `renameSync` ile atomik olarak hedef dosyanın yerine taşır.
 * 5. Herhangi bir aşamada hata oluşursa geçici `.tmp` dosyasını temizler ve önceki hedef dosyayı korur.
 */
export function writeJsonFileAtomic(
  targetPath: string,
  serializedJson: string,
  options: AtomicWriteOptions = {}
): void {
  if (typeof serializedJson !== 'string' || !serializedJson.trim()) {
    throw new Error('Atomik yazma için boş JSON içeriği kabul edilmez.');
  }

  let parsedPayload: any;
  try {
    parsedPayload = JSON.parse(serializedJson);
  } catch (err: any) {
    throw new Error(`Yazılacak içerik geçerli bir JSON değil: ${err?.message || err}`);
  }

  if (options.validateParsed && !options.validateParsed(parsedPayload)) {
    throw new Error('Yazılacak JSON içeriği şema doğrulamasından geçemedi.');
  }

  const dir = path.dirname(targetPath);
  mkdirSync(dir, { recursive: true });

  if (options.backupPath && existsSync(targetPath)) {
    const existingCheck = tryParseValidJson(targetPath, options.validateParsed ? (r) => (options.validateParsed!(r) ? r : null) : undefined);
    if (existingCheck.ok) {
      mkdirSync(path.dirname(options.backupPath), { recursive: true });
      copyFileSync(targetPath, options.backupPath);
    }
  }

  tempFileSeq = (tempFileSeq + 1) % 1_000_000;
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${tempFileSeq}.tmp`;
  const buffer = Buffer.from(serializedJson, 'utf8');

  let fd: number | null = null;
  try {
    fd = openSync(tempPath, 'w', 0o600);
    writeFileSync(fd, buffer);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    const writtenStat = statSync(tempPath);
    if (writtenStat.size !== buffer.byteLength) {
      throw new Error(
        `Geçici dosya boyutu uyuşmuyor (beklenen ${buffer.byteLength}, yazılan ${writtenStat.size}).`
      );
    }

    if (options.beforeRenameHook) {
      options.beforeRenameHook(tempPath);
    }

    renameSync(tempPath, targetPath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {}
    throw err;
  }
}

/**
 * JSON dosyasını okur; bozuksa hata kaydı üretir, bozuk dosyayı karantinaya kopyalar
 * ve varsa geçerli yedeklerden kurtarmayı dener. Kurtarma başarısızsa sessizce boş veri dönmez.
 */
export function readJsonFileWithRecovery<T = any>(
  targetPath: string,
  options: ReadJsonRecoveryOptions<T> = {}
): ReadJsonRecoveryResult<T> {
  const { backupPaths = [], validate, label = path.basename(targetPath), restoreRecoveredToTarget = true } = options;

  if (!existsSync(targetPath)) {
    for (const candidateBackup of backupPaths) {
      if (!existsSync(candidateBackup)) continue;
      const check = tryParseValidJson(candidateBackup, validate);
      if (check.ok) {
        if (restoreRecoveredToTarget) {
          try {
            writeJsonFileAtomic(targetPath, readFileSync(candidateBackup, 'utf8'));
          } catch {}
        }
        return { status: 'recovered', data: check.data, recoveredFrom: candidateBackup };
      }
    }
    return { status: 'missing', data: null };
  }

  const primaryCheck = tryParseValidJson(targetPath, validate);
  if (primaryCheck.ok) {
    return { status: 'ok', data: primaryCheck.data };
  }

  console.error(`[Storage] Bozuk veri dosyası algılandı (${label}): ${primaryCheck.error}`);

  let quarantinePath: string | undefined;
  try {
    quarantinePath = `${targetPath}.corrupt.${Date.now()}`;
    copyFileSync(targetPath, quarantinePath);
  } catch {}

  for (const candidateBackup of backupPaths) {
    if (!existsSync(candidateBackup)) continue;
    const backupCheck = tryParseValidJson(candidateBackup, validate);
    if (backupCheck.ok) {
      console.warn(`[Storage] ${label} geçerli yedekten kurtarıldı: ${path.basename(candidateBackup)}`);
      if (restoreRecoveredToTarget) {
        try {
          writeJsonFileAtomic(targetPath, readFileSync(candidateBackup, 'utf8'));
        } catch {}
      }
      return { status: 'recovered', data: backupCheck.data, recoveredFrom: candidateBackup };
    }
  }

  return {
    status: 'corrupt_unrecoverable',
    data: null,
    error: primaryCheck.error,
    quarantinePath,
  };
}

async function fileExistsAsync(targetPath: string): Promise<boolean> {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function tryParseValidJsonAsync<T = any>(
  filePath: string,
  validate?: (raw: any) => T | null
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const text = await fsPromises.readFile(filePath, 'utf8');
    const raw = JSON.parse(text);
    if (validate) {
      const validated = validate(raw);
      if (validated === null) {
        return { ok: false, error: 'Şema doğrulaması başarısız.' };
      }
      return { ok: true, data: validated };
    }
    return { ok: true, data: raw as T };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'JSON ayrıştırma hatası.' };
  }
}

export async function writeJsonFileAtomicAsync(
  targetPath: string,
  serializedJson: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  if (typeof serializedJson !== 'string' || !serializedJson.trim()) {
    throw new Error('Atomik yazma için boş JSON içeriği kabul edilmez.');
  }

  let parsedPayload: any;
  try {
    parsedPayload = JSON.parse(serializedJson);
  } catch (err: any) {
    throw new Error(`Yazılacak içerik geçerli bir JSON değil: ${err?.message || err}`);
  }

  if (options.validateParsed && !options.validateParsed(parsedPayload)) {
    throw new Error('Yazılacak JSON içeriği şema doğrulamasından geçemedi.');
  }

  const dir = path.dirname(targetPath);
  await fsPromises.mkdir(dir, { recursive: true });

  if (options.backupPath && (await fileExistsAsync(targetPath))) {
    const existingCheck = await tryParseValidJsonAsync(
      targetPath,
      options.validateParsed ? (r) => (options.validateParsed!(r) ? r : null) : undefined
    );
    if (existingCheck.ok) {
      await fsPromises.mkdir(path.dirname(options.backupPath), { recursive: true });
      await fsPromises.copyFile(targetPath, options.backupPath);
    }
  }

  tempFileSeq = (tempFileSeq + 1) % 1_000_000;
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${tempFileSeq}.tmp`;
  const buffer = Buffer.from(serializedJson, 'utf8');

  let handle: fsPromises.FileHandle | null = null;
  try {
    handle = await fsPromises.open(tempPath, 'w', 0o600);
    await handle.writeFile(buffer);
    await handle.datasync();
    await handle.close();
    handle = null;

    const writtenStat = await fsPromises.stat(tempPath);
    if (writtenStat.size !== buffer.byteLength) {
      throw new Error(
        `Geçici dosya boyutu uyuşmuyor (beklenen ${buffer.byteLength}, yazılan ${writtenStat.size}).`
      );
    }

    if (options.beforeRenameHook) {
      options.beforeRenameHook(tempPath);
    }

    await fsPromises.rename(tempPath, targetPath);
  } catch (err) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {}
    }
    try {
      if (await fileExistsAsync(tempPath)) {
        await fsPromises.unlink(tempPath);
      }
    } catch {}
    throw err;
  }
}

export async function readJsonFileWithRecoveryAsync<T = any>(
  targetPath: string,
  options: ReadJsonRecoveryOptions<T> = {}
): Promise<ReadJsonRecoveryResult<T>> {
  const {
    backupPaths = [],
    validate,
    label = path.basename(targetPath),
    restoreRecoveredToTarget = true,
  } = options;

  if (!(await fileExistsAsync(targetPath))) {
    for (const candidateBackup of backupPaths) {
      if (!(await fileExistsAsync(candidateBackup))) continue;
      const check = await tryParseValidJsonAsync(candidateBackup, validate);
      if (check.ok) {
        if (restoreRecoveredToTarget) {
          try {
            const rawText = await fsPromises.readFile(candidateBackup, 'utf8');
            await writeJsonFileAtomicAsync(targetPath, rawText);
          } catch {}
        }
        return { status: 'recovered', data: check.data, recoveredFrom: candidateBackup };
      }
    }
    return { status: 'missing', data: null };
  }

  const primaryCheck = await tryParseValidJsonAsync(targetPath, validate);
  if (primaryCheck.ok) {
    return { status: 'ok', data: primaryCheck.data };
  }

  console.error(`[Storage] Bozuk veri dosyası algılandı (${label}): ${primaryCheck.error}`);

  let quarantinePath: string | undefined;
  try {
    quarantinePath = `${targetPath}.corrupt.${Date.now()}`;
    await fsPromises.copyFile(targetPath, quarantinePath);
  } catch {}

  for (const candidateBackup of backupPaths) {
    if (!(await fileExistsAsync(candidateBackup))) continue;
    const backupCheck = await tryParseValidJsonAsync(candidateBackup, validate);
    if (backupCheck.ok) {
      console.warn(
        `[Storage] ${label} geçerli yedekten kurtarıldı: ${path.basename(candidateBackup)}`
      );
      if (restoreRecoveredToTarget) {
        try {
          const rawText = await fsPromises.readFile(candidateBackup, 'utf8');
          await writeJsonFileAtomicAsync(targetPath, rawText);
        } catch {}
      }
      return { status: 'recovered', data: backupCheck.data, recoveredFrom: candidateBackup };
    }
  }

  return {
    status: 'corrupt_unrecoverable',
    data: null,
    error: primaryCheck.error,
    quarantinePath,
  };
}

/**
 * Aynı hedef dosyaya yönelen eşzamanlı asenkron yazma işlemlerini sıraya sokar.
 */
export class FileWriteSerializer {
  private queues = new Map<string, Promise<any>>();

  public run<T>(filePath: string, task: () => Promise<T> | T): Promise<T> {
    const normalizedPath = path.resolve(filePath);
    const previous = this.queues.get(normalizedPath) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => task());

    const tracked = next.finally(() => {
      if (this.queues.get(normalizedPath) === tracked) {
        this.queues.delete(normalizedPath);
      }
    });
    this.queues.set(normalizedPath, tracked);
    return next;
  }
}
