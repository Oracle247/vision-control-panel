import { app } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { PM2Status, RunPm2Options } from '../types';
import { getBackendEnv } from './env-manager';
import { getNodeExecutable } from '../utils/node-runtime';
import { prepareBackend } from './config.service';
import { RuntimePaths } from '../utils/runtime-files';

const ECOSYSTEM_PATH = RuntimePaths.ecosystem();


// export function getPm2Bin(): string {
//   if (!app.isPackaged) {
//     return require.resolve("pm2/bin/pm2");
//   }

//   const pm2 = path.join(
//     process.resourcesPath,
//     "app.asar.unpacked",
//     "node_modules",
//     "pm2",
//     "bin",
//     "pm2"
//   );

//   if (!fs.existsSync(pm2)) {
//     throw new Error(`PM2 binary not found:\n${pm2}`);
//   }

//   return pm2;
// }

export function getPm2Bin() {
  if (!app.isPackaged) {
    return require.resolve("pm2/bin/pm2");
  }

  return path.join(
    RuntimePaths.node(),
    "node_modules",
    "pm2",
    "bin",
    "pm2"
  );
}

function runPm2(
  args: string[],
  options: RunPm2Options = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      getNodeExecutable(),
      [getPm2Bin(), ...args],
      {
        shell: false,
        cwd: options.cwd || path.dirname(ECOSYSTEM_PATH),
        env: {
          ...process.env,
          ...getBackendEnv(),
        },
        windowsHide: true,
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      options.onLog?.(text);
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      options.onLog?.(text);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      console.log("========== PM2 OUTPUT ==========");
      console.log("STDOUT:");
      console.log(stdout);
      console.log("STDERR:");
      console.log(stderr);
      console.log("===============================");

      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `PM2 exited with code ${code}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`
          )
        );
      }
    });

    // child.on("close", (code) => {
    //   if (code === 0) {
    //     resolve(stdout);
    //   } else {
    //     reject(
    //       new Error(stderr || `PM2 exited with code ${code}`)
    //     );
    //   }
    // });
  });
}

export async function start(): Promise<void> {
  prepareBackend();

  await runPm2(['start', ECOSYSTEM_PATH, '--update-env']);
}

export async function stop(): Promise<void> {
  await runPm2(['stop', 'vfc-backend']);
}

export async function restart(): Promise<void> {
  prepareBackend();
  try {
    await runPm2(['restart', 'vfc-backend', '--update-env']);
  } catch {
    await start();
  }
}

/**
 * Kill the PM2 daemon entirely. Use this when env changes need to take effect
 * deterministically — `--update-env` covers app env on restart, but the daemon
 * itself caches a separate copy that influences how it forks child processes.
 * After this call, the next start() launches a fresh daemon with the current env.
 */
export async function killDaemon(): Promise<void> {
  try {
    await runPm2(['kill']);
  } catch {
    // Daemon may already be dead; nothing to do.
  }
}

export async function getStatus(): Promise<PM2Status> {
  try {
    const output = await runPm2(['jlist']);
    const processes = JSON.parse(output);
    const proc = processes.find((p: any) => p.name === 'vfc-backend');

    if (!proc) {
      return { running: false, pid: null, uptime: 0, memory: 0, restarts: 0 };
    }

    return {
      running: proc.pm2_env.status === 'online',
      pid: proc.pid,
      uptime: proc.pm2_env.pm_uptime || 0,
      memory: proc.monit?.memory || 0,
      restarts: proc.pm2_env.restart_time || 0,
      status: proc.pm2_env.status,
    };
  } catch {
    return { running: false, pid: null, uptime: 0, memory: 0, restarts: 0 };
  }
}

export function streamLogs(onLine: (line: string) => void): ChildProcess {
  const child = spawn(
    getNodeExecutable(),
    [
      getPm2Bin(),
      'logs',
      'vfc-backend',
      '--raw',
      '--lines',
      '50',
    ],
    {
      shell: false,
      cwd: path.dirname(ECOSYSTEM_PATH),
      env: {
        ...process.env,
        ...getBackendEnv(),
      },
      windowsHide: true,
    }
  );

  const processData = (data: Buffer): void => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        onLine(line);
      }
    }
  };

  child.stdout.on('data', processData);
  child.stderr.on('data', processData);

  child.on('error', (err: Error) => {
    onLine(`[Error] ${err.message}`);
  });

  return child;
}

export async function deletePm2(): Promise<void> {
  try {
    await runPm2(['delete', 'vfc-backend']);
  } catch {
    // Process may not exist, ignore
  }
}
