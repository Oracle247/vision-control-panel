"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const pm2Manager = __importStar(require("./lib/pm2-manager"));
const deployManager = __importStar(require("./lib/deploy-manager"));
const dbManager = __importStar(require("./lib/db-manager"));
const envManager = __importStar(require("./lib/env-manager"));
const fs_1 = __importDefault(require("fs"));
const pg_1 = require("pg");
const lan_detector_1 = require("./lib/lan-detector");
const config_service_1 = require("./lib/config.service");
const configuration_manager_1 = require("./lib/configuration-manager");
let mainWindow = null;
let logChild = null;
let shuttingDown = false;
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 950,
        height: 750,
        minWidth: 800,
        minHeight: 600,
        title: 'Vision Control Panel',
        webPreferences: {
            preload: path_1.default.join(__dirname, '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    mainWindow.loadFile(path_1.default.join(__dirname, '..', 'renderer', 'dist', 'index.html'));
    mainWindow.on('closed', () => {
        mainWindow = null;
        if (logChild) {
            try {
                logChild.kill();
            }
            catch { }
            logChild = null;
        }
    });
}
// Stop the backend PM2 process whenever the control panel is shutting down.
// Idempotent: safe to call from both `before-quit` and `window-all-closed`.
async function shutdownBackend() {
    if (shuttingDown)
        return;
    shuttingDown = true;
    if (logChild) {
        try {
            logChild.kill();
        }
        catch { }
        logChild = null;
    }
    try {
        await pm2Manager.stop();
    }
    catch {
        // backend may already be stopped, or pm2 not reachable — nothing to do
    }
}
electron_1.app.whenReady().then(async () => {
    (0, config_service_1.ensureConfiguration)();
    (0, config_service_1.syncBackendEnv)();
    try {
        await pm2Manager.killDaemon();
    }
    catch {
        // No daemon running, or pm2 not reachable yet — both are fine.
    }
    createWindow();
});
// Block first quit attempt so we can stop the backend cleanly, then quit for real.
electron_1.app.on('before-quit', (event) => {
    if (shuttingDown)
        return;
    event.preventDefault();
    shutdownBackend().finally(() => electron_1.app.quit());
});
electron_1.app.on('window-all-closed', () => {
    shutdownBackend().finally(() => electron_1.app.quit());
});
electron_1.app.on('activate', () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0)
        createWindow();
});
// --- IPC Handlers ---
// PM2 Controls
electron_1.ipcMain.handle('pm2:start', async () => {
    try {
        await pm2Manager.start();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
electron_1.ipcMain.handle('pm2:stop', async () => {
    try {
        await pm2Manager.stop();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
electron_1.ipcMain.handle('pm2:restart', async () => {
    try {
        await pm2Manager.restart();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
electron_1.ipcMain.handle('pm2:status', async () => {
    return await pm2Manager.getStatus();
});
// PM2 Log Streaming
electron_1.ipcMain.on('pm2:logs', (_event) => {
    if (logChild) {
        try {
            logChild.kill();
        }
        catch { }
    }
    logChild = pm2Manager.streamLogs((line) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pm2:log-data', line);
        }
    });
});
electron_1.ipcMain.on('pm2:logs-stop', () => {
    if (logChild) {
        try {
            logChild.kill();
        }
        catch { }
        logChild = null;
    }
});
// Deploy
electron_1.ipcMain.on('deploy:start', (_event, target) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        deployManager.deploy(mainWindow.webContents, { target });
    }
});
electron_1.ipcMain.on('deploy:continue', (_event, fromStep, target) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        deployManager.deploy(mainWindow.webContents, { target, startFromStep: fromStep });
    }
});
electron_1.ipcMain.on('deploy:cancel', () => {
    deployManager.cancel();
});
// LAN Info
electron_1.ipcMain.handle('lan:get-info', () => {
    return (0, lan_detector_1.getURLs)();
});
// Settings: env file (DATABASE_URL, JWT_SECRET, etc.) lives in userData
electron_1.ipcMain.handle('settings:get-env', () => {
    return {
        path: envManager.getEnvPath(),
        content: envManager.readEnvFile(),
    };
});
electron_1.ipcMain.handle('settings:save-env', async (_event, content) => {
    try {
        envManager.writeEnvFile(content);
        // The userData .env just changed. Kill the PM2 daemon so the next start
        // can't accidentally reuse its in-memory copy of the old DATABASE_URL.
        try {
            await pm2Manager.killDaemon();
        }
        catch {
            // ok if daemon wasn't running
        }
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
// Configuration - structured
electron_1.ipcMain.handle('configuration:load', async () => {
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
            }
            catch (e) {
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
        const advanced = {};
        for (const [k, v] of Object.entries(merged)) {
            if (!known.has(k))
                advanced[k] = v;
        }
        // last saved timestamp (userData .env)
        let lastSaved = null;
        try {
            const st = fs_1.default.statSync(envManager.getEnvPath());
            lastSaved = st.mtime.toISOString();
        }
        catch { }
        return { success: true, data: { general, db, security, email, advanced, lastSaved } };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
electron_1.ipcMain.handle("configuration:restore-defaults", async () => {
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
electron_1.ipcMain.handle('configuration:save', async (_event, config) => {
    try {
        // Build env object
        const obj = {};
        if (config.general?.applicationName)
            obj.APP_NAME = String(config.general.applicationName);
        if (config.general?.port)
            obj.PORT = String(config.general.port);
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
            if (parts.schema)
                obj.PG_SCHEMA = String(parts.schema);
        }
        // Security
        if (config.security?.jwtSecret)
            obj.JWT_SECRET = String(config.security.jwtSecret);
        if (config.security?.accessTokenExpiry)
            obj.ACCESS_TOKEN_EXPIRY = String(config.security.accessTokenExpiry);
        if (config.security?.refreshTokenExpiry)
            obj.REFRESH_TOKEN_EXPIRY = String(config.security.refreshTokenExpiry);
        // Email
        if (config.email) {
            if (config.email.smtpHost)
                obj.SMTP_HOST = String(config.email.smtpHost);
            if (config.email.smtpPort)
                obj.SMTP_PORT = String(config.email.smtpPort);
            if (config.email.smtpUsername)
                obj.SMTP_USERNAME = String(config.email.smtpUsername);
            if (config.email.smtpPassword)
                obj.SMTP_PASSWORD = String(config.email.smtpPassword);
            if (config.email.smtpSecure !== undefined)
                obj.SMTP_SECURE = config.email.smtpSecure ? 'true' : 'false';
        }
        // Advanced
        if (config.advanced && typeof config.advanced === 'object') {
            for (const [k, v] of Object.entries(config.advanced)) {
                obj[k] = String(v);
            }
        }
        const content = envManager.stringifyDotEnv(obj);
        // Determine backend path if available
        const packagedBackendDir = process.resourcesPath ? path_1.default.join(process.resourcesPath, "runtime", "backend") : null;
        if (packagedBackendDir && fs_1.default.existsSync(packagedBackendDir)) {
            const backendEnvPath = path_1.default.join(packagedBackendDir, '.env');
            fs_1.default.writeFileSync(backendEnvPath, content, 'utf-8');
        }
        // Also persist to userData .env for runtime edits
        envManager.writeEnvFile(content);
        // Ensure PM2 daemon won't reuse old env cache
        try {
            await pm2Manager.killDaemon();
        }
        catch { }
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
electron_1.ipcMain.handle('configuration:import', async () => {
    if (!mainWindow || mainWindow.isDestroyed())
        return { success: false, error: 'Window not available' };
    const { canceled, filePaths } = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: 'Import .env file',
        properties: ['openFile'],
        filters: [{ name: '.env files', extensions: ['env', 'txt'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (canceled || !filePaths || !filePaths[0])
        return { success: false, error: 'cancelled' };
    try {
        const text = fs_1.default.readFileSync(filePaths[0], 'utf-8');
        const parsed = envManager.parseDotEnvText(text);
        // Reuse configuration:load logic by merging parsed over backend
        const merged = { ...envManager.getBackendEnv(), ...parsed };
        // Build response similar to configuration:load
        const u = {};
        if (merged.DATABASE_URL) {
            try {
                const url = new URL(merged.DATABASE_URL);
                u.host = url.hostname;
                u.port = url.port || '5432';
                u.database = url.pathname.replace(/^\//, '');
                u.username = decodeURIComponent(url.username);
                u.password = decodeURIComponent(url.password);
            }
            catch { }
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
            advanced: Object.fromEntries(Object.entries(merged).filter(([k]) => ![
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
            ].includes(k))),
        };
        // Persist immediately
        const cfg = (0, config_service_1.uiConfigToConfig)(response);
        (0, configuration_manager_1.saveConfigurationToBackendEnv)(cfg);
        return {
            success: true,
            data: response,
        };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
electron_1.ipcMain.handle('configuration:export', async (_event, content) => {
    if (!mainWindow || mainWindow.isDestroyed())
        return { success: false, error: 'Window not available' };
    const { canceled, filePath } = await electron_1.dialog.showSaveDialog(mainWindow, { title: 'Export .env', defaultPath: 'vfc.env', filters: [{ name: 'env', extensions: ['env', 'txt'] }] });
    if (canceled || !filePath)
        return { success: false, error: 'cancelled' };
    try {
        fs_1.default.writeFileSync(filePath, content, 'utf-8');
        return { success: true, filePath };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
electron_1.ipcMain.handle('configuration:test-database', async (_event, dbParts) => {
    try {
        const user = dbParts.username || '';
        const password = dbParts.password || '';
        const host = dbParts.host || 'localhost';
        const port = Number(dbParts.port || 5432);
        const database = dbParts.database || '';
        const client = new pg_1.Client({ user, password, host, port, database });
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
// Database dump
electron_1.ipcMain.handle('db:dump', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: 'Window not available' };
    }
    const { canceled, filePath } = await electron_1.dialog.showSaveDialog(mainWindow, {
        title: 'Save database dump',
        defaultPath: dbManager.defaultDumpFilename(),
        filters: [{ name: 'SQL', extensions: ['sql'] }],
    });
    if (canceled || !filePath) {
        return { success: false, error: 'cancelled' };
    }
    try {
        const send = (line) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('db:dump-log', line);
            }
        };
        const result = await dbManager.dumpDatabase(filePath, send);
        return { success: true, filePath, bytes: result.bytes };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
});
//# sourceMappingURL=main.js.map