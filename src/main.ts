import { app, BrowserWindow, ipcMain, IpcMainEvent, dialog } from 'electron';
import path from 'path';
import { ChildProcess } from 'child_process';
import * as pm2Manager from './lib/pm2-manager';
import * as deployManager from './lib/deploy-manager';
import * as dbManager from './lib/db-manager';
import * as envManager from './lib/env-manager';
import fs from 'fs';
import { Client } from 'pg';
import { getURLs } from './lib/lan-detector';
import { ensureConfiguration, syncBackendEnv, uiConfigToConfig } from './lib/config.service';
import { saveConfigurationToBackendEnv } from './lib/configuration-manager';

let mainWindow: BrowserWindow | null = null;
let logChild: ChildProcess | null = null;
let shuttingDown = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'Vision Control Panel',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (logChild) {
      try { logChild.kill(); } catch { }
      logChild = null;
    }
  });
}

// Stop the backend PM2 process whenever the control panel is shutting down.
// Idempotent: safe to call from both `before-quit` and `window-all-closed`.
async function shutdownBackend(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (logChild) {
    try { logChild.kill(); } catch { }
    logChild = null;
  }
  try {
    await pm2Manager.stop();
  } catch {
    // backend may already be stopped, or pm2 not reachable — nothing to do
  }
}

app.whenReady().then(async () => {
  ensureConfiguration();

  syncBackendEnv();

  try {
    await pm2Manager.killDaemon();
  } catch {
    // No daemon running, or pm2 not reachable yet — both are fine.
  }
  createWindow();
});

// Block first quit attempt so we can stop the backend cleanly, then quit for real.
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shutdownBackend().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  shutdownBackend().finally(() => app.quit());
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// --- IPC Handlers ---

// PM2 Controls
ipcMain.handle('pm2:start', async () => {
  try {
    await pm2Manager.start();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('pm2:stop', async () => {
  try {
    await pm2Manager.stop();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('pm2:restart', async () => {
  try {
    await pm2Manager.restart();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('pm2:status', async () => {
  return await pm2Manager.getStatus();
});

// PM2 Log Streaming
ipcMain.on('pm2:logs', (_event: IpcMainEvent) => {
  if (logChild) {
    try { logChild.kill(); } catch { }
  }
  logChild = pm2Manager.streamLogs((line: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pm2:log-data', line);
    }
  });
});

ipcMain.on('pm2:logs-stop', () => {
  if (logChild) {
    try { logChild.kill(); } catch { }
    logChild = null;
  }
});

// Deploy
ipcMain.on('deploy:start', (_event: IpcMainEvent, target?: deployManager.DeployTarget) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    deployManager.deploy(mainWindow.webContents, { target });
  }
});

ipcMain.on('deploy:continue', (_event: IpcMainEvent, fromStep: number, target?: deployManager.DeployTarget) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    deployManager.deploy(mainWindow.webContents, { target, startFromStep: fromStep });
  }
});

ipcMain.on('deploy:cancel', () => {
  deployManager.cancel();
});

// LAN Info
ipcMain.handle('lan:get-info', () => {
  return getURLs();
});

// Settings: env file (DATABASE_URL, JWT_SECRET, etc.) lives in userData
ipcMain.handle('settings:get-env', () => {
  return {
    path: envManager.getEnvPath(),
    content: envManager.readEnvFile(),
  };
});

ipcMain.handle('settings:save-env', async (_event, content: string) => {
  try {
    envManager.writeEnvFile(content);
    // The userData .env just changed. Kill the PM2 daemon so the next start
    // can't accidentally reuse its in-memory copy of the old DATABASE_URL.
    try {
      await pm2Manager.killDaemon();
    } catch {
      // ok if daemon wasn't running
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Configuration - structured
ipcMain.handle('configuration:load', async () => {
  try {
    const merged = envManager.getBackendEnv();

    // Basic sections
    const general = {
      applicationName: merged.APP_NAME || '',
      port: merged.PORT || merged.PORT || '',
      nodeEnv: merged.NODE_ENV || 'production',
    };

    // Database - parse DATABASE_URL if present
    const db = {
      host: '',
      port: '',
      database: '',
      username: '',
      password: '',
      schema: merged.PG_SCHEMA || merged.PGSCHEMA || '',
    };
    if (merged.DATABASE_URL) {
      try {
        const u = new URL(merged.DATABASE_URL);
        db.host = u.hostname;
        db.port = u.port || '5432';
        db.database = u.pathname.replace(/^\//, '');
        db.username = decodeURIComponent(u.username || '');
        db.password = decodeURIComponent(u.password || '');
      } catch (e) {
        // ignore parse errors
      }
    }

    const security = {
      jwtSecret: merged.JWT_SECRET || '',
      accessTokenExpiry: merged.ACCESS_TOKEN_EXPIRY || '',
      refreshTokenExpiry: merged.REFRESH_TOKEN_EXPIRY || '',
    };

    const email = {
      smtpHost: merged.SMTP_HOST || '',
      smtpPort: merged.SMTP_PORT || '',
      smtpUsername: merged.SMTP_USERNAME || '',
      smtpPassword: merged.SMTP_PASSWORD || '',
      smtpSecure: merged.SMTP_SECURE === 'true' || false,
    };

    const known = new Set([
      'APP_NAME', 'PORT', 'NODE_ENV', 'DATABASE_URL', 'JWT_SECRET',
      'ACCESS_TOKEN_EXPIRY', 'REFRESH_TOKEN_EXPIRY', 'SMTP_HOST', 'SMTP_PORT',
      'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_SECURE', 'VCP_LOG_DIR', 'PG_SCHEMA'
    ]);

    const advanced: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (!known.has(k)) advanced[k] = v;
    }

    // last saved timestamp (userData .env)
    let lastSaved: string | null = null;
    try {
      const st = fs.statSync(envManager.getEnvPath());
      lastSaved = st.mtime.toISOString();
    } catch { }

    return { success: true, data: { general, db, security, email, advanced, lastSaved } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("configuration:restore-defaults", async () => {
  return {
    success: true,
    data: {
      general: {
        applicationName: "Vision Church",
        port: "3030",
        nodeEnv: "production",
      },
      db: {
        host: "localhost",
        port: "5432",
        database: "",
        username: "postgres",
        password: "",
        schema: "public",
      },
      security: {
        jwtSecret: "",
        accessTokenExpiry: "720",
        refreshTokenExpiry: "720",
      },
      email: {
        smtpHost: "",
        smtpPort: "587",
        smtpUsername: "",
        smtpPassword: "",
        smtpSecure: false,
      },
      advanced: {},
      lastSaved: null,
    },
  };
});

ipcMain.handle('configuration:save', async (_event, config) => {
  try {
    // Build env object
    const obj: Record<string, string> = {};
    if (config.general?.applicationName) obj.APP_NAME = String(config.general.applicationName);
    if (config.general?.port) obj.PORT = String(config.general.port);
    obj.NODE_ENV = 'production';

    // Database
    if (config.db) {
      const parts = config.db;
      const user = encodeURIComponent(parts.username || '');
      const pass = encodeURIComponent(parts.password || '');
      const host = parts.host || 'localhost';
      const port = parts.port || '5432';
      const database = parts.database || '';
      obj.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${database}`;
      if (parts.schema) obj.PG_SCHEMA = String(parts.schema);
    }

    // Security
    if (config.security?.jwtSecret) obj.JWT_SECRET = String(config.security.jwtSecret);
    if (config.security?.accessTokenExpiry) obj.ACCESS_TOKEN_EXPIRY = String(config.security.accessTokenExpiry);
    if (config.security?.refreshTokenExpiry) obj.REFRESH_TOKEN_EXPIRY = String(config.security.refreshTokenExpiry);

    // Email
    if (config.email) {
      if (config.email.smtpHost) obj.SMTP_HOST = String(config.email.smtpHost);
      if (config.email.smtpPort) obj.SMTP_PORT = String(config.email.smtpPort);
      if (config.email.smtpUsername) obj.SMTP_USERNAME = String(config.email.smtpUsername);
      if (config.email.smtpPassword) obj.SMTP_PASSWORD = String(config.email.smtpPassword);
      if (config.email.smtpSecure !== undefined) obj.SMTP_SECURE = config.email.smtpSecure ? 'true' : 'false';
    }

    // Advanced
    if (config.advanced && typeof config.advanced === 'object') {
      for (const [k, v] of Object.entries(config.advanced)) {
        obj[k] = String(v);
      }
    }

    const content = envManager.stringifyDotEnv(obj);

    // Determine backend path if available
    const packagedBackendDir = process.resourcesPath ? path.join(process.resourcesPath, "runtime", "backend") : null;
    if (packagedBackendDir && fs.existsSync(packagedBackendDir)) {
      const backendEnvPath = path.join(packagedBackendDir, '.env');
      fs.writeFileSync(backendEnvPath, content, 'utf-8');
    }
    // Also persist to userData .env for runtime edits
    envManager.writeEnvFile(content);

    // Ensure PM2 daemon won't reuse old env cache
    try { await pm2Manager.killDaemon(); } catch { }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('configuration:import', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: 'Window not available' };
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import .env file',
    properties: ['openFile'],
    filters: [{ name: '.env files', extensions: ['env', 'txt'] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (canceled || !filePaths || !filePaths[0]) return { success: false, error: 'cancelled' };
  try {
    const text = fs.readFileSync(filePaths[0], 'utf-8');
    const parsed = envManager.parseDotEnvText(text);
    // Reuse configuration:load logic by merging parsed over backend
    const merged = { ...envManager.getBackendEnv(), ...parsed };
    // Build response similar to configuration:load
    const u: any = {};
    if (merged.DATABASE_URL) {
      try { const url = new URL(merged.DATABASE_URL); u.host = url.hostname; u.port = url.port || '5432'; u.database = url.pathname.replace(/^\//, ''); u.username = decodeURIComponent(url.username); u.password = decodeURIComponent(url.password); } catch { }
    }
    const response = {
      general: {
        applicationName: merged.APP_NAME || "",
        port: merged.PORT || "",
        nodeEnv: merged.NODE_ENV || "production",
      },
      db: {
        host: u.host || "",
        port: u.port || "",
        database: u.database || "",
        username: u.username || "",
        password: u.password || "",
        schema: merged.PG_SCHEMA || "",
      },
      security: {
        jwtSecret: merged.JWT_SECRET || "",
        accessTokenExpiry: merged.ACCESS_TOKEN_EXPIRY || "",
        refreshTokenExpiry: merged.REFRESH_TOKEN_EXPIRY || "",
      },
      email: {
        smtpHost: merged.SMTP_HOST || "",
        smtpPort: merged.SMTP_PORT || "",
        smtpUsername: merged.SMTP_USERNAME || "",
        smtpPassword: merged.SMTP_PASSWORD || "",
        smtpSecure: merged.SMTP_SECURE === "true",
      },
      advanced: Object.fromEntries(
        Object.entries(merged).filter(
          ([k]) =>
            ![
              "APP_NAME",
              "PORT",
              "NODE_ENV",
              "DATABASE_URL",
              "JWT_SECRET",
              "ACCESS_TOKEN_EXPIRY",
              "REFRESH_TOKEN_EXPIRY",
              "SMTP_HOST",
              "SMTP_PORT",
              "SMTP_USERNAME",
              "SMTP_PASSWORD",
              "SMTP_SECURE",
              "VCP_LOG_DIR",
              "PG_SCHEMA",
            ].includes(k)
        )
      ),
    };

    // Persist immediately
    const cfg = uiConfigToConfig(response);
    saveConfigurationToBackendEnv(cfg);

    return {
      success: true,
      data: response,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('configuration:export', async (_event, content: string) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: 'Window not available' };
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { title: 'Export .env', defaultPath: 'vfc.env', filters: [{ name: 'env', extensions: ['env', 'txt'] }] });
  if (canceled || !filePath) return { success: false, error: 'cancelled' };
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, filePath };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('configuration:test-database', async (_event, dbParts) => {
  try {
    const user = dbParts.username || '';
    const password = dbParts.password || '';
    const host = dbParts.host || 'localhost';
    const port = Number(dbParts.port || 5432);
    const database = dbParts.database || '';
    const client = new Client({ user, password, host, port, database });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Database dump
ipcMain.handle('db:dump', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { success: false, error: 'Window not available' };
  }
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save database dump',
    defaultPath: dbManager.defaultDumpFilename(),
    filters: [{ name: 'SQL', extensions: ['sql'] }],
  });
  if (canceled || !filePath) {
    return { success: false, error: 'cancelled' };
  }
  try {
    const send = (line: string) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('db:dump-log', line);
      }
    };
    const result = await dbManager.dumpDatabase(filePath, send);
    return { success: true, filePath, bytes: result.bytes };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
