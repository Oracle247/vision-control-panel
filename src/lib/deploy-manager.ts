import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { WebContents } from 'electron';
import { getLanIP } from './lan-detector';
import * as pm2Manager from './pm2-manager';
import { RuntimePaths } from '../utils/runtime-files';

const BACKEND_DIR = RuntimePaths.backend();
const FRONTEND_DIR = path.resolve(__dirname, '../../../vfc-frontend');
const PWA_DIR = path.resolve(__dirname, '../../../vision-attendance-pwa');

let activeChildren: ChildProcess[] = [];
let cancelled = false;

function runCommand(cmd: string, args: string[], cwd: string, onLog: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true, cwd, env: { ...process.env } });
    activeChildren.push(child);

    const processData = (data: Buffer): void => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) onLog(line.trim());
      }
    };

    child.stdout.on('data', processData);
    child.stderr.on('data', processData);

    child.on('close', (code: number | null) => {
      activeChildren = activeChildren.filter(c => c !== child);
      if (cancelled) {
        reject(new Error('Deploy cancelled'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', (err: Error) => {
      activeChildren = activeChildren.filter(c => c !== child);
      reject(err);
    });
  });
}

// API base URL is now resolved at runtime from window.location.hostname in
// each frontend's apiClient, so we no longer write .env files here. This
// patch only fixes up app-specific config files that the frontends expect.
function patchFrontendConfig(_lanIP: string): void {
  const apiClientPath = path.join(FRONTEND_DIR, 'lib', 'apiClient.ts');
  if (fs.existsSync(apiClientPath)) {
    let content = fs.readFileSync(apiClientPath, 'utf-8');
    if (content.includes('window.location.href = "/login"')) {
      content = content.replace(
        'window.location.href = "/login"',
        'window.location.href = "/login"'
      );
      fs.writeFileSync(apiClientPath, content, 'utf-8');
    }
  }
}

function patchPwaConfig(_lanIP: string): void {
  const viteConfigPath = path.join(PWA_DIR, 'vite.config.ts');
  if (fs.existsSync(viteConfigPath)) {
    let content = fs.readFileSync(viteConfigPath, 'utf-8');

    if (!content.includes("base:")) {
      content = content.replace(
        'export default defineConfig({',
        "export default defineConfig({\n  base: '/terminal/',"
      );
    } else {
      content = content.replace(/base:\s*['"][^'"]*['"]/g, "base: '/terminal/'");
    }

    content = content.replace(/scope:\s*['"][^'"]*['"]/g, "scope: '/terminal/'");
    content = content.replace(/start_url:\s*['"][^'"]*['"]/g, "start_url: '/terminal/'");

    content = content.replace(/src:\s*'\/pwa-/g, "src: '/terminal/pwa-");
    content = content.replace(/src:\s*'\/favicon/g, "src: '/terminal/favicon");
    content = content.replace(/src:\s*'\/apple-touch/g, "src: '/terminal/apple-touch");

    fs.writeFileSync(viteConfigPath, content, 'utf-8');
  }
}

function patchBackendSpa(): void {
  const middlewareDir = path.join(BACKEND_DIR, 'src', 'core', 'middlewares');
  const spaMiddlewarePath = path.join(middlewareDir, 'SpaMiddleware.ts');

  if (!fs.existsSync(spaMiddlewarePath)) {
    if (!fs.existsSync(middlewareDir)) {
      fs.mkdirSync(middlewareDir, { recursive: true });
    }
    fs.writeFileSync(spaMiddlewarePath, `import { Request, Response, NextFunction } from 'express';
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

  const appTsPath = path.join(BACKEND_DIR, 'src', 'app.ts');
  let appContent = fs.readFileSync(appTsPath, 'utf-8');

  if (!appContent.includes('initializeSpaRoutes')) {
    if (!appContent.includes('SpaMiddleware')) {
      appContent = appContent.replace(
        "import { globalErrorHandler } from './core/middlewares/ErrorMiddleware';",
        "import { globalErrorHandler } from './core/middlewares/ErrorMiddleware';\nimport { spaFallback } from './core/middlewares/SpaMiddleware';"
      );
    }

    appContent = appContent.replace(
      'this.initializeRoutes(routes);',
      'this.initializeRoutes(routes);\n    this.initializeSpaRoutes();'
    );

    const spaMethod = `
  private initializeSpaRoutes() {
    logger.info('Initializing SPA Routes ....');
    this.app.use('/admin/*', spaFallback('admin'));
    this.app.use('/terminal/*', spaFallback('terminal'));
    logger.info('SPA Routes Initialized Successfully');
  }

`;
    appContent = appContent.replace(
      '  private initializeErrorHandling()',
      spaMethod + '  private initializeErrorHandling()'
    );

    fs.writeFileSync(appTsPath, appContent, 'utf-8');
  }
}

export type DeployTarget = 'all' | 'backend' | 'admin' | 'terminal';

export interface DeployOptions {
  target?: DeployTarget;
  startFromStep?: number;
}

// Each target only runs the steps it actually needs.
// Step 0 (pre-flight) always runs but only applies patches relevant to the target.
// admin/terminal skip step 6 because they only update static files served by Express.
const STEPS_FOR_TARGET: Record<DeployTarget, number[]> = {
  all: [0, 1, 2, 3, 4, 5, 6],
  backend: [0, 1, 6],
  admin: [0, 2, 4],
  terminal: [0, 3, 5],
};

export async function deploy(sender: WebContents, options: DeployOptions = {}): Promise<void> {
  cancelled = false;
  activeChildren = [];
  const lanIP = getLanIP();
  const target: DeployTarget = options.target ?? 'all';
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

  const shouldRun = (step: number): boolean => activeSteps.has(step) && startFromStep <= step;

  const sendProgress = (step: number, status: string, detail?: string): void => {
    sender.send('deploy:progress', { step, name: steps[step], status, detail });
  };

  const sendLog = (line: string): void => {
    sender.send('deploy:log', line);
  };

  let currentStep = 0;

  try {
    sendLog(`Deploy target: ${target}${startFromStep > 0 ? ` (resuming from step ${startFromStep})` : ''}`);
    if (startFromStep > 0) {
      for (let i = 0; i < startFromStep; i++) {
        if (activeSteps.has(i)) sendProgress(i, 'done');
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
        const logsDir = path.join(BACKEND_DIR, 'logs');
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      }

      sendProgress(0, 'done');
      if (cancelled) throw new Error('Deploy cancelled');
    }

    // Step 1: Build Backend
    if (shouldRun(1)) {
      currentStep = 1;
      sendProgress(1, 'running');
      sendLog('Building backend (TypeScript → JavaScript)...');
      await runCommand('npm', ['run', 'build'], BACKEND_DIR, sendLog);
      sendProgress(1, 'done');
      if (cancelled) throw new Error('Deploy cancelled');
    }

    // Step 2: Build Admin Panel
    if (shouldRun(2)) {
      currentStep = 2;
      sendProgress(2, 'running');
      sendLog('Building admin panel (Next.js)...');
      await runCommand('npm', ['run', 'build'], FRONTEND_DIR, sendLog);
      sendProgress(2, 'done');
      if (cancelled) throw new Error('Deploy cancelled');
    }

    // Step 3: Build Terminal PWA
    if (shouldRun(3)) {
      currentStep = 3;
      sendProgress(3, 'running');
      sendLog('Building terminal PWA (Vite)...');
      await runCommand('npm', ['run', 'build'], PWA_DIR, sendLog);
      sendProgress(3, 'done');
      if (cancelled) throw new Error('Deploy cancelled');
    }

    // Step 4: Copy Admin -> public/admin/
    if (shouldRun(4)) {
      currentStep = 4;
      sendProgress(4, 'running');
      const adminSrc = path.join(FRONTEND_DIR, 'out');
      const adminDest = path.join(BACKEND_DIR, 'public', 'home');

      sendLog('Copying admin build to server...');
      if (fs.existsSync(adminDest)) {
        fs.rmSync(adminDest, { recursive: true, force: true });
      }
      fs.cpSync(adminSrc, adminDest, { recursive: true });
      sendLog(`Copied admin build to ${adminDest}`);
      sendProgress(4, 'done');
      if (cancelled) throw new Error('Deploy cancelled');
    }

    // Step 5: Copy Terminal -> public/terminal/
    if (shouldRun(5)) {
      currentStep = 5;
      sendProgress(5, 'running');
      const pwaSrc = path.join(PWA_DIR, 'dist');
      const pwaDest = path.join(BACKEND_DIR, 'public', 'terminal');

      sendLog('Copying terminal build to server...');
      if (fs.existsSync(pwaDest)) {
        fs.rmSync(pwaDest, { recursive: true, force: true });
      }
      fs.cpSync(pwaSrc, pwaDest, { recursive: true });
      sendLog(`Copied terminal build to ${pwaDest}`);
      sendProgress(5, 'done');
      if (cancelled) throw new Error('Deploy cancelled');
    }

    // Step 6: Restart Server (skipped for admin/terminal — they only update static files)
    if (shouldRun(6)) {
      currentStep = 6;
      sendProgress(6, 'running');
      sendLog('Restarting server via PM2...');
      try {
        await pm2Manager.restart();
      } catch {
        sendLog('PM2 process not found, starting fresh...');
        await pm2Manager.start();
      }
      sendLog('Server restarted successfully!');
      sendProgress(6, 'done');
    }

    sender.send('deploy:complete', { success: true });

  } catch (err: any) {
    sendLog(`[ERROR] ${err.message}`);
    sendProgress(currentStep, 'error');
    sender.send('deploy:complete', { success: false, error: err.message });
  }
}

export function cancel(): void {
  cancelled = true;
  for (const child of activeChildren) {
    try { child.kill('SIGTERM'); } catch { }
  }
  activeChildren = [];
}
