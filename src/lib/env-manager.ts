import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import os from "node:os";
import { getBackendEnvPath } from './config.service';
import { RuntimePaths } from '../utils/runtime-files';

export function getAppDataDir() {
  const dir = path.join(
    os.homedir(),
    "Documents",
    "Vision Control Panel"
  );

  fs.mkdirSync(dir, { recursive: true });

  return dir;
}

// Default values written into the userData stub on first launch.
// Mirrored as STUB_VALUES so the merge in getBackendEnv() can detect
// "user hasn't edited this yet" and fall through to vfc-backend/.env.
const STUB_VALUES: Record<string, string> = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/vfc',
  JWT_SECRET: 'change-me',
};

const STUB_ENV = `# Vision Control Panel - backend environment.
# Edit these values, then click "Start" (or "Restart") in the panel.
# Any value left at its default below will be ignored in favour of the same
# key in vfc-backend/.env (so a single edit in either file works).
DATABASE_URL=${STUB_VALUES.DATABASE_URL}
JWT_SECRET=${STUB_VALUES.JWT_SECRET}
`;

/**
 * Locate vfc-backend/.env so it can act as a fallback for any key in the
 * userData .env that's still at its auto-stub default. This makes editing
 * either file work and removes the silent two-source-of-truth foot-gun.
 *
 * Packaged: resources/backend/.env (sibling of resources/ecosystem.config.js).
 * Dev: oracle_codes/vfc-backend/.env (three levels up from src/lib/).
 */
export function getBackendDotEnvPath(): string | null {
  const packagedBackendDir = RuntimePaths.backend();
  if (packagedBackendDir && fs.existsSync(packagedBackendDir)) {
    return path.join(packagedBackendDir, '.env');
  }
  // Dev: __dirname is something like <repo>/vision-control-panel/dist/lib or
  // src/lib depending on the build. Resolve up to oracle_codes/ then sideways.
  const devCandidates = [
    path.resolve(__dirname, '..', '..', '..', 'vfc-backend', '.env'),
    path.resolve(__dirname, '..', '..', 'vfc-backend', '.env'),
  ];
  return devCandidates.find((p) => fs.existsSync(p)) ?? null;
}

let cachedUserData: string | null = null;

function userData(): string {
  if (!cachedUserData) {
    cachedUserData = getAppDataDir();
  }

  return cachedUserData;
}

export function getEnvPath(): string {
  return path.join(userData(), '.env');
}

export function getLogsDir(): string {
  const base = userData();

  const dir = path.join(base, "logs");

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return dir;
}

/**
 * Ensure a writable .env exists in userData. Creates a stub the first time the
 * app launches so the renderer's Settings tab has something to load.
 */
export function ensureEnvFile(): void {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, STUB_ENV, 'utf-8');
  }
}

/**
 * Parse a dotenv-style file into a plain object. Minimal subset — KEY=VALUE,
 * comments starting with #, blank lines ignored. Values are NOT shell-expanded.
 */
export function parseDotEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  const text = fs.readFileSync(filePath, 'utf-8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Parse dotenv-style text into an object (same rules as parseDotEnv). */
export function parseDotEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Convert an object into dotenv formatted text. Keys are sorted for determinism. */
export function stringifyDotEnv(obj: Record<string, string>): string {
  const lines: string[] = [];
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  for (const key of keys) {
    const value = obj[key];
    // Quote values that contain spaces or # or leading/trailing spaces
    const needsQuotes = /\s|#/.test(value) || value.length === 0;
    const outVal = needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
    lines.push(`${key}=${outVal}`);
  }
  return lines.join('\n') + '\n';
}

export function getBackendEnv(): Record<string, string> {
  const backendPath = getBackendEnvPath();
  const fromBackend = backendPath ? parseDotEnv(backendPath) : {};
  const fromUserData = parseDotEnv(getEnvPath());

  const merged: Record<string, string> = { ...fromBackend };
  for (const [key, value] of Object.entries(fromUserData)) {
    // If userData still holds the auto-stub for this key, defer to the backend
    // file so editing either side works without manual sync.
    if (STUB_VALUES[key] !== undefined && value === STUB_VALUES[key]) continue;
    merged[key] = value;
  }

  merged.VCP_LOG_DIR = getLogsDir();
  return merged;
}

export function syncBackendEnv(): void {
  const source = path.join(getAppDataDir(), ".env");

  const destination = path.join(
    RuntimePaths.backend(),
    ".env"
  );

  if (!fs.existsSync(source)) {
    throw new Error(`Source .env not found: ${source}`);
  }

  fs.copyFileSync(source, destination);

  console.log("Backend .env synchronized.");
}

/** Read the raw .env text for the renderer's Settings tab. */
export function readEnvFile(): string {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) return STUB_ENV;
  return fs.readFileSync(envPath, 'utf-8');
}

/** Write raw .env text from the renderer's Settings tab. */
export function writeEnvFile(content: string): void {
  const envPath = getEnvPath();
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content, 'utf-8');
}
