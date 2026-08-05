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
exports.deploy = deploy;
exports.cancel = cancel;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const lan_detector_1 = require("./lan-detector");
const pm2Manager = __importStar(require("./pm2-manager"));
const runtime_files_1 = require("../utils/runtime-files");
const BACKEND_DIR = runtime_files_1.RuntimePaths.backend();
const FRONTEND_DIR = path_1.default.resolve(__dirname, '../../../vfc-frontend');
const PWA_DIR = path_1.default.resolve(__dirname, '../../../vision-attendance-pwa');
let activeChildren = [];
let cancelled = false;
function runCommand(cmd, args, cwd, onLog) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(cmd, args, { shell: true, cwd, env: { ...process.env } });
        activeChildren.push(child);
        const processData = (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.trim())
                    onLog(line.trim());
            }
        };
        child.stdout.on('data', processData);
        child.stderr.on('data', processData);
        child.on('close', (code) => {
            activeChildren = activeChildren.filter(c => c !== child);
            if (cancelled) {
                reject(new Error('Deploy cancelled'));
            }
            else if (code === 0) {
                resolve();
            }
            else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });
        child.on('error', (err) => {
            activeChildren = activeChildren.filter(c => c !== child);
            reject(err);
        });
    });
}
// API base URL is now resolved at runtime from window.location.hostname in
// each frontend's apiClient, so we no longer write .env files here. This
// patch only fixes up app-specific config files that the frontends expect.
function patchFrontendConfig(_lanIP) {
    const apiClientPath = path_1.default.join(FRONTEND_DIR, 'lib', 'apiClient.ts');
    if (fs_1.default.existsSync(apiClientPath)) {
        let content = fs_1.default.readFileSync(apiClientPath, 'utf-8');
        if (content.includes('window.location.href = "/login"')) {
            content = content.replace('window.location.href = "/login"', 'window.location.href = "/login"');
            fs_1.default.writeFileSync(apiClientPath, content, 'utf-8');
        }
    }
}
function patchPwaConfig(_lanIP) {
    const viteConfigPath = path_1.default.join(PWA_DIR, 'vite.config.ts');
    if (fs_1.default.existsSync(viteConfigPath)) {
        let content = fs_1.default.readFileSync(viteConfigPath, 'utf-8');
        if (!content.includes("base:")) {
            content = content.replace('export default defineConfig({', "export default defineConfig({\n  base: '/terminal/',");
        }
        else {
            content = content.replace(/base:\s*['"][^'"]*['"]/g, "base: '/terminal/'");
        }
        content = content.replace(/scope:\s*['"][^'"]*['"]/g, "scope: '/terminal/'");
        content = content.replace(/start_url:\s*['"][^'"]*['"]/g, "start_url: '/terminal/'");
        content = content.replace(/src:\s*'\/pwa-/g, "src: '/terminal/pwa-");
        content = content.replace(/src:\s*'\/favicon/g, "src: '/terminal/favicon");
        content = content.replace(/src:\s*'\/apple-touch/g, "src: '/terminal/apple-touch");
        fs_1.default.writeFileSync(viteConfigPath, content, 'utf-8');
    }
}
function patchBackendSpa() {
    const middlewareDir = path_1.default.join(BACKEND_DIR, 'src', 'core', 'middlewares');
    const spaMiddlewarePath = path_1.default.join(middlewareDir, 'SpaMiddleware.ts');
    if (!fs_1.default.existsSync(spaMiddlewarePath)) {
        if (!fs_1.default.existsSync(middlewareDir)) {
            fs_1.default.mkdirSync(middlewareDir, { recursive: true });
        }
        fs_1.default.writeFileSync(spaMiddlewarePath, `import { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';

export function spaFallback(subPath: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();
    if (req.path.includes('.')) return next();
    const indexFile = path.join(__dirname, '../../public', subPath, 'index.html');
    if (fs.existsSync(indexFile)) {
      res.sendFile(indexFile);
    } else {
      next();
    }
  };
}
`, 'utf-8');
    }
    const appTsPath = path_1.default.join(BACKEND_DIR, 'src', 'app.ts');
    let appContent = fs_1.default.readFileSync(appTsPath, 'utf-8');
    if (!appContent.includes('initializeSpaRoutes')) {
        if (!appContent.includes('SpaMiddleware')) {
            appContent = appContent.replace("import { globalErrorHandler } from './core/middlewares/ErrorMiddleware';", "import { globalErrorHandler } from './core/middlewares/ErrorMiddleware';\nimport { spaFallback } from './core/middlewares/SpaMiddleware';");
        }
        appContent = appContent.replace('this.initializeRoutes(routes);', 'this.initializeRoutes(routes);\n    this.initializeSpaRoutes();');
        const spaMethod = `
  private initializeSpaRoutes() {
    logger.info('Initializing SPA Routes ....');
    this.app.use('/admin/*', spaFallback('admin'));
    this.app.use('/terminal/*', spaFallback('terminal'));
    logger.info('SPA Routes Initialized Successfully');
  }

`;
        appContent = appContent.replace('  private initializeErrorHandling()', spaMethod + '  private initializeErrorHandling()');
        fs_1.default.writeFileSync(appTsPath, appContent, 'utf-8');
    }
}
// Each target only runs the steps it actually needs.
// Step 0 (pre-flight) always runs but only applies patches relevant to the target.
// admin/terminal skip step 6 because they only update static files served by Express.
const STEPS_FOR_TARGET = {
    all: [0, 1, 2, 3, 4, 5, 6],
    backend: [0, 1, 6],
    admin: [0, 2, 4],
    terminal: [0, 3, 5],
};
async function deploy(sender, options = {}) {
    cancelled = false;
    activeChildren = [];
    const lanIP = (0, lan_detector_1.getLanIP)();
    const target = options.target ?? 'all';
    const startFromStep = options.startFromStep ?? 0;
    const activeSteps = new Set(STEPS_FOR_TARGET[target]);
    const steps = [
        'Prepare Environment',
        'Build Backend',
        'Build Admin Panel',
        'Build Terminal PWA',
        'Copy Admin to Server',
        'Copy Terminal to Server',
        'Restart Server',
    ];
    const shouldRun = (step) => activeSteps.has(step) && startFromStep <= step;
    const sendProgress = (step, status, detail) => {
        sender.send('deploy:progress', { step, name: steps[step], status, detail });
    };
    const sendLog = (line) => {
        sender.send('deploy:log', line);
    };
    let currentStep = 0;
    try {
        sendLog(`Deploy target: ${target}${startFromStep > 0 ? ` (resuming from step ${startFromStep})` : ''}`);
        if (startFromStep > 0) {
            for (let i = 0; i < startFromStep; i++) {
                if (activeSteps.has(i))
                    sendProgress(i, 'done');
            }
        }
        // Step 0: Pre-flight (always for any target, but patches are target-scoped)
        if (shouldRun(0)) {
            currentStep = 0;
            sendProgress(0, 'running');
            sendLog(`Detected LAN IP: ${lanIP}`);
            if (target === 'all' || target === 'admin') {
                sendLog('Patching admin config (.env, apiClient.ts)...');
                patchFrontendConfig(lanIP);
            }
            if (target === 'all' || target === 'terminal') {
                sendLog('Patching terminal PWA config (vite.config.ts, .env)...');
                patchPwaConfig(lanIP);
            }
            if (target === 'all' || target === 'backend') {
                sendLog('Patching backend SPA middleware...');
                patchBackendSpa();
                const logsDir = path_1.default.join(BACKEND_DIR, 'logs');
                if (!fs_1.default.existsSync(logsDir))
                    fs_1.default.mkdirSync(logsDir, { recursive: true });
            }
            sendProgress(0, 'done');
            if (cancelled)
                throw new Error('Deploy cancelled');
        }
        // Step 1: Build Backend
        if (shouldRun(1)) {
            currentStep = 1;
            sendProgress(1, 'running');
            sendLog('Building backend (TypeScript → JavaScript)...');
            await runCommand('npm', ['run', 'build'], BACKEND_DIR, sendLog);
            sendProgress(1, 'done');
            if (cancelled)
                throw new Error('Deploy cancelled');
        }
        // Step 2: Build Admin Panel
        if (shouldRun(2)) {
            currentStep = 2;
            sendProgress(2, 'running');
            sendLog('Building admin panel (Next.js)...');
            await runCommand('npm', ['run', 'build'], FRONTEND_DIR, sendLog);
            sendProgress(2, 'done');
            if (cancelled)
                throw new Error('Deploy cancelled');
        }
        // Step 3: Build Terminal PWA
        if (shouldRun(3)) {
            currentStep = 3;
            sendProgress(3, 'running');
            sendLog('Building terminal PWA (Vite)...');
            await runCommand('npm', ['run', 'build'], PWA_DIR, sendLog);
            sendProgress(3, 'done');
            if (cancelled)
                throw new Error('Deploy cancelled');
        }
        // Step 4: Copy Admin -> public/admin/
        if (shouldRun(4)) {
            currentStep = 4;
            sendProgress(4, 'running');
            const adminSrc = path_1.default.join(FRONTEND_DIR, 'out');
            const adminDest = path_1.default.join(BACKEND_DIR, 'public', 'home');
            sendLog('Copying admin build to server...');
            if (fs_1.default.existsSync(adminDest)) {
                fs_1.default.rmSync(adminDest, { recursive: true, force: true });
            }
            fs_1.default.cpSync(adminSrc, adminDest, { recursive: true });
            sendLog(`Copied admin build to ${adminDest}`);
            sendProgress(4, 'done');
            if (cancelled)
                throw new Error('Deploy cancelled');
        }
        // Step 5: Copy Terminal -> public/terminal/
        if (shouldRun(5)) {
            currentStep = 5;
            sendProgress(5, 'running');
            const pwaSrc = path_1.default.join(PWA_DIR, 'dist');
            const pwaDest = path_1.default.join(BACKEND_DIR, 'public', 'terminal');
            sendLog('Copying terminal build to server...');
            if (fs_1.default.existsSync(pwaDest)) {
                fs_1.default.rmSync(pwaDest, { recursive: true, force: true });
            }
            fs_1.default.cpSync(pwaSrc, pwaDest, { recursive: true });
            sendLog(`Copied terminal build to ${pwaDest}`);
            sendProgress(5, 'done');
            if (cancelled)
                throw new Error('Deploy cancelled');
        }
        // Step 6: Restart Server (skipped for admin/terminal — they only update static files)
        if (shouldRun(6)) {
            currentStep = 6;
            sendProgress(6, 'running');
            sendLog('Restarting server via PM2...');
            try {
                await pm2Manager.restart();
            }
            catch {
                sendLog('PM2 process not found, starting fresh...');
                await pm2Manager.start();
            }
            sendLog('Server restarted successfully!');
            sendProgress(6, 'done');
        }
        sender.send('deploy:complete', { success: true });
    }
    catch (err) {
        sendLog(`[ERROR] ${err.message}`);
        sendProgress(currentStep, 'error');
        sender.send('deploy:complete', { success: false, error: err.message });
    }
}
function cancel() {
    cancelled = true;
    for (const child of activeChildren) {
        try {
            child.kill('SIGTERM');
        }
        catch { }
    }
    activeChildren = [];
}
//# sourceMappingURL=deploy-manager.js.map