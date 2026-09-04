import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { ThresholdsMs } from '../core/config';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface LaLogPaths {
  dataDir: string; // ~/.lalog
  activeDir: string; // dataDir/active
  sessionsFile: string; // dataDir/sessions.jsonl (all closed sessions)
  exportsDir: string; // dataDir/exports
  reportsDir: string; // dataDir/reports
}

export function buildPaths(dataDirRaw: string): LaLogPaths {
  const dataDir = expandHome(dataDirRaw);
  return {
    dataDir,
    activeDir: path.join(dataDir, 'active'),
    sessionsFile: path.join(dataDir, 'sessions.jsonl'),
    exportsDir: path.join(dataDir, 'exports'),
    reportsDir: path.join(dataDir, 'reports'),
  };
}

export function ensureDirs(p: LaLogPaths): void {
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.mkdirSync(p.activeDir, { recursive: true });
  fs.mkdirSync(p.exportsDir, { recursive: true });
  fs.mkdirSync(p.reportsDir, { recursive: true });
}

export function workspaceKey(folderUri: string): string {
  const normalized = folderUri
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^~/, os.homedir());
  const real = safeRealpath(normalized) ?? normalized;
  return crypto.createHash('sha1').update(real).digest('hex').slice(0, 10);
}

export function workspaceName(folderUri: string): string {
  const clean = folderUri.replace(/\\/g, '/').replace(/\/+$/, '');
  return decodeURIComponent(clean.substring(clean.lastIndexOf('/') + 1)) || 'Workspace';
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export function sessionId(startedAt: number, wsKey: string): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const prefix = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}`;
  const rand = crypto.randomBytes(2).toString('hex');
  return `${prefix}-${wsKey.slice(0, 4)}-${rand}`;
}

/** JSONL: append a single line, POSIX near-atomic. */
export function appendLine(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(data) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

export function saveSnapshot(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic
}

export function readSnapshot<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function listActive(activeDir: string): string[] {
  try {
    return fs.readdirSync(activeDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

export async function streamLines(file: string, onLine: (obj: unknown) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(file)) return resolve();
      const stream = fs.createReadStream(file, { encoding: 'utf8' }) as NodeJS.ReadableStream;
      let buffer = '';
      stream.on('data', (chunk: unknown) => {
        buffer += String(chunk);
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            try {
              onLine(JSON.parse(line));
            } catch {
              /* skip malformed */
            }
          }
        }
      });
      stream.on('end', () => resolve());
      stream.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

export { Readable };
