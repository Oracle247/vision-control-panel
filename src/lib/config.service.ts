import fs from "fs";
import path from "path";
import { app } from "electron";
import { Config } from "./configuration-manager";
import { RuntimePaths } from "../utils/runtime-files";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function runNode(
  args: string[],
  cwd: string
) {
  return execFileAsync(
    RuntimePaths.node(),
    args,
    {
      cwd,
      env: process.env,
    }
  );
}

export function getConfigDirectory() {
  const dir = path.join(
    app.getPath("documents"),
    "Vision Control Panel"
  );

  fs.mkdirSync(dir, { recursive: true });

  return dir;
}


export function getBackendPath() {
  const packaged = path.join(__dirname, "runtime", "backend");

  if (fs.existsSync(packaged)) {
    return packaged;
  }

  return path.resolve(__dirname, "..", "vfc-backend");
}

export function getNodePath() {
  const packaged = path.join(__dirname, "runtime", "node");

  if (fs.existsSync(packaged)) {
    return packaged;
  }

  return path.resolve(__dirname, "..", "node-runtime");
}

export function getConfigEnvPath() {
  return path.join(getConfigDirectory(), ".env");
}

export function getBackendEnvPath() {
  if (app.isPackaged) {
    return RuntimePaths.backend() + "/.env";
  }

  return path.join(
    __dirname,
    "../../",
    "../vfc-backend",
    ".env"
  );
}
export function syncBackendEnv() {

  const source = getConfigEnvPath();

  const destination = getBackendEnvPath();

  const sourceText = fs.readFileSync(
    source,
    "utf8"
  );

  const destinationText =
    fs.existsSync(destination)
      ? fs.readFileSync(destination, "utf8")
      : "";

  if (sourceText === destinationText) {

    return;
  }

  fs.writeFileSync(
    destination,
    sourceText
  );
}

export function ensureConfiguration() {
  const config = getConfigEnvPath();

  if (fs.existsSync(config)) {
    return;
  }

  fs.copyFileSync(
    getBackendEnvPath(),
    config
  );
}

export function uiConfigToConfig(ui: any): Config {
  return {
    general: {
      APP_NAME: ui.general.applicationName,
      PORT: ui.general.port,
    },

    database: {
      host: ui.db.host,
      port: ui.db.port,
      database: ui.db.database,
      user: ui.db.username,
      password: ui.db.password,
      schema: ui.db.schema,
    },

    security: {
      JWT_SECRET: ui.security.jwtSecret,
      ACCESS_TOKEN_EXPIRY: ui.security.accessTokenExpiry,
      REFRESH_TOKEN_EXPIRY: ui.security.refreshTokenExpiry,
    },

    email: {
      SMTP_HOST: ui.email.smtpHost,
      SMTP_PORT: ui.email.smtpPort,
      SMTP_USER: ui.email.smtpUsername,
      SMTP_PASS: ui.email.smtpPassword,
      SMTP_SECURE: ui.email.smtpSecure,
    },

    advanced: ui.advanced,
  };
}

export function writeFileAtomic(file: string, text: string) {
  const tmp = `${file}.tmp`;

  fs.writeFileSync(tmp, text, "utf8");

  fs.renameSync(tmp, file);
}

function verifyRuntime() {

  const required = [

    RuntimePaths.backend(),

    RuntimePaths.node(),

    RuntimePaths.ecosystem(),

    RuntimePaths.manifest()

  ];

  for (const file of required) {

    if (!fs.existsSync(file)) {

      throw new Error(
        `Runtime missing:\n${file}`
      );

    }

  }

}

export async function prepareBackend() {

  ensureConfiguration();

  verifyRuntime();

  syncBackendEnv();

  const backend = RuntimePaths.backend();

  await runNode([
    "node_modules/prisma/build/index.js",
    "migrate",
    "deploy",
    "--schema",
    "prisma/schema.prisma"
  ], backend);

}