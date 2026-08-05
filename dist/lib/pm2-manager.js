"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPm2Bin = getPm2Bin;
exports.start = start;
exports.stop = stop;
exports.restart = restart;
exports.killDaemon = killDaemon;
exports.getStatus = getStatus;
exports.streamLogs = streamLogs;
exports.deletePm2 = deletePm2;
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const env_manager_1 = require("./env-manager");
const node_runtime_1 = require("../utils/node-runtime");
const config_service_1 = require("./config.service");
const runtime_files_1 = require("../utils/runtime-files");
const ECOSYSTEM_PATH = runtime_files_1.RuntimePaths.ecosystem();
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
function getPm2Bin() {
    if (!electron_1.app.isPackaged) {
        return require.resolve("pm2/bin/pm2");
    }
    return path_1.default.join(runtime_files_1.RuntimePaths.node(), "node_modules", "pm2", "bin", "pm2");
}
function runPm2(args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)((0, node_runtime_1.getNodeExecutable)(), [getPm2Bin(), ...args], {
            shell: false,
            cwd: options.cwd || path_1.default.dirname(ECOSYSTEM_PATH),
            env: {
                ...process.env,
                ...(0, env_manager_1.getBackendEnv)(),
            },
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => {
            const text = data.toString();
            stdout += text;
            options.onLog?.(text);
        });
        child.stderr.on("data", (data) => {
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
            }
            else {
                reject(new Error(`PM2 exited with code ${code}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`));
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
async function start() {
    (0, config_service_1.prepareBackend)();
    await runPm2(['start', ECOSYSTEM_PATH, '--update-env']);
}
async function stop() {
    await runPm2(['stop', 'vfc-backend']);
}
async function restart() {
    (0, config_service_1.prepareBackend)();
    try {
        await runPm2(['restart', 'vfc-backend', '--update-env']);
    }
    catch {
        await start();
    }
}
/**
 * Kill the PM2 daemon entirely. Use this when env changes need to take effect
 * deterministically — `--update-env` covers app env on restart, but the daemon
 * itself caches a separate copy that influences how it forks child processes.
 * After this call, the next start() launches a fresh daemon with the current env.
 */
async function killDaemon() {
    try {
        await runPm2(['kill']);
    }
    catch {
        // Daemon may already be dead; nothing to do.
    }
}
async function getStatus() {
    try {
        const output = await runPm2(['jlist']);
        const processes = JSON.parse(output);
        const proc = processes.find((p) => p.name === 'vfc-backend');
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
    }
    catch {
        return { running: false, pid: null, uptime: 0, memory: 0, restarts: 0 };
    }
}
function streamLogs(onLine) {
    const child = (0, child_process_1.spawn)((0, node_runtime_1.getNodeExecutable)(), [
        getPm2Bin(),
        'logs',
        'vfc-backend',
        '--raw',
        '--lines',
        '50',
    ], {
        shell: false,
        cwd: path_1.default.dirname(ECOSYSTEM_PATH),
        env: {
            ...process.env,
            ...(0, env_manager_1.getBackendEnv)(),
        },
        windowsHide: true,
    });
    const processData = (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            if (line.trim()) {
                onLine(line);
            }
        }
    };
    child.stdout.on('data', processData);
    child.stderr.on('data', processData);
    child.on('error', (err) => {
        onLine(`[Error] ${err.message}`);
    });
    return child;
}
async function deletePm2() {
    try {
        await runPm2(['delete', 'vfc-backend']);
    }
    catch {
        // Process may not exist, ignore
    }
}
//# sourceMappingURL=pm2-manager.js.map