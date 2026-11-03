// GitHub token'ının Windows Credential Manager (Git Credential Manager) üzerinden
// otomatik tazelenmesi. GCM, kullanıcının GitHub yetkilendirmesini saklar ve
// `git credential fill` çağrısında süresi dolmuş OAuth token'larını kendisi yeniler.
// Böylece .env'deki gho_ token'ının (~8 saatlik) süresi dolsa bile senkron çalışmaya
// devam eder. Kullanıcının kalıcı token'ı (ghp_ / github_pat_) varsa ona dokunulmaz.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function isDurableGitHubToken(token: string): boolean {
  const t = (token || '').trim();
  return t.startsWith('ghp_') || t.startsWith('github_pat_');
}

export function fetchGitHubTokenFromCredentialManager(
  username: string,
  timeoutMs = 45_000
): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['credential', 'fill'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // yok say
      }
      finish(null);
    }, timeoutMs);

    if (!child.stdout || !child.stdin) {
      clearTimeout(timer);
      finish(null);
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', () => {
      // GCM hata çıktısı yok sayılır; sonuç çıktıdan ayrıştırılır
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const passwordLine = stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith('password='));
      const token = passwordLine ? passwordLine.slice('password='.length).trim() : '';
      finish(token.length > 0 ? token : null);
    });

    const input = `protocol=https\nhost=github.com\n${username ? `username=${username}\n` : ''}\n`;
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

export async function refreshEnvGitHubPat(options: {
  envFilePath: string;
  currentToken: string;
  username?: string;
  timeoutMs?: number;
  forceReplaceInvalidToken?: boolean;
}): Promise<string | null> {
  const {
    envFilePath,
    currentToken,
    username = '',
    timeoutMs = 45_000,
    forceReplaceInvalidToken = false,
  } = options;
  const trimmedCurrent = (currentToken || '').trim();

  // Normal tazelemede kullanıcının kalıcı token'ı ezilmez; ancak GitHub 401 döndürdüyse yenilenebilir
  if (!forceReplaceInvalidToken && trimmedCurrent && isDurableGitHubToken(trimmedCurrent)) {
    return null;
  }
  if (!existsSync(envFilePath)) return null;

  const fresh = await fetchGitHubTokenFromCredentialManager(username, timeoutMs);
  if (!fresh || fresh === trimmedCurrent) return null;

  const raw = readFileSync(envFilePath, 'utf8');
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (/^CINETRACK_GITHUB_PAT\s*=/.test(line)) {
      replaced = true;
      return `CINETRACK_GITHUB_PAT=${fresh}`;
    }
    return line;
  });
  if (!replaced) next.push(`CINETRACK_GITHUB_PAT=${fresh}`);
  writeFileSync(envFilePath, next.join(newline), 'utf8');
  return fresh;
}
