import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { RuntimePaths } from '../utils/runtime-files';

const BACKEND_DIR = RuntimePaths.backend();

interface ParsedDbUrl {
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
}

function readDatabaseUrl(): string | null {
  const envPath = path.join(BACKEND_DIR, '.env');
  if (!fs.existsSync(envPath)) return null;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}

function parseDatabaseUrl(url: string): ParsedDbUrl {
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port: parsed.port || '5432',
    database: parsed.pathname.replace(/^\//, ''),
  };
}

export function defaultDumpFilename(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `vfc-backup-${ts}.sql`;
}

/**
 * Runs pg_dump in plain-SQL format. Resolves with the bytes written.
 * Requires `pg_dump` on PATH (ships with PostgreSQL client tools).
 */
export function dumpDatabase(
  destinationPath: string,
  onLog: (line: string) => void,
): Promise<{ bytes: number }> {
  return new Promise((resolve, reject) => {
    const url = readDatabaseUrl();
    if (!url) {
      reject(new Error(`DATABASE_URL not found in ${path.join(BACKEND_DIR, '.env')}`));
      return;
    }

    let creds: ParsedDbUrl;
    try {
      creds = parseDatabaseUrl(url);
    } catch (err) {
      reject(new Error(`Could not parse DATABASE_URL: ${(err as Error).message}`));
      return;
    }

    onLog(`Dumping ${creds.database} from ${creds.host}:${creds.port} as ${creds.user}...`);
    onLog(`Output: ${destinationPath}`);

    const out = fs.createWriteStream(destinationPath);
    let bytes = 0;

    const child = spawn(
      'pg_dump',
      [
        '--host', creds.host,
        '--port', creds.port,
        '--username', creds.user,
        '--dbname', creds.database,
        '--no-owner',
        '--no-privileges',
        '--format=plain',
      ],
      {
        shell: true,
        env: { ...process.env, PGPASSWORD: creds.password },
      },
    );

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      out.write(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) onLog(text);
    });

    child.on('error', (err) => {
      out.close();
      reject(new Error(`Failed to spawn pg_dump: ${err.message}. Is PostgreSQL client installed and on PATH?`));
    });

    child.on('close', (code) => {
      out.close();
      if (code === 0) {
        onLog(`Done. Wrote ${bytes.toLocaleString()} bytes.`);
        resolve({ bytes });
      } else {
        try { fs.unlinkSync(destinationPath); } catch { }
        reject(new Error(`pg_dump exited with code ${code}`));
      }
    });
  });
}
