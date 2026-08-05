#!/usr/bin/env node
// Stage a production-only copy of vfc-backend at ../vfc-backend/.stage so
// electron-builder can ship a slim bundle instead of the full dev tree.
//
// Contents of the staged folder:
//   dist/        compiled JS, source maps stripped
//   prisma/      schema.prisma + migrations/ (no seed.ts, no local sqlite)
//   public/      built admin + terminal SPAs
//   package.json (copied as-is, used by `npm ci --omit=dev`)
//   node_modules production-only install
//
// Run before electron-builder via `npm run prepackage:backend`.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONTROL_PANEL = path.resolve(__dirname, '..');
const BACKEND = path.resolve(CONTROL_PANEL, '..', 'vfc-backend');
const RUNTIME = path.join(CONTROL_PANEL, "runtime");
const STAGE = path.join(RUNTIME, "backend");

function log(msg) {
  process.stdout.write(`[stage-backend] ${msg}\n`);
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sPath = path.join(src, entry.name);
    const dPath = path.join(dest, entry.name);
    if (filter && !filter(sPath, entry)) continue;
    if (entry.isDirectory()) {
      copyDir(sPath, dPath, filter);
    } else if (entry.isFile()) {
      fs.copyFileSync(sPath, dPath);
    }
  }
}

function assertExists(p, what) {
  if (!fs.existsSync(p)) {
    throw new Error(`${what} not found at ${p}. Build the backend first.`);
  }
}

function main() {
  assertExists(path.join(BACKEND, 'dist', 'server.js'), 'compiled backend (dist/server.js)');
  assertExists(path.join(BACKEND, 'prisma', 'schema.prisma'), 'prisma/schema.prisma');
  assertExists(path.join(BACKEND, 'package.json'), 'vfc-backend/package.json');
  assertExists(path.join(BACKEND, '.env.template'), 'vfc-backend/.env.template');

  log(`staging into ${STAGE}`);

  // Ensure runtime exists
  fs.mkdirSync(RUNTIME, { recursive: true });

  // Clean previous backend runtime
  rmrf(STAGE);

  // Recreate backend folder
  fs.mkdirSync(STAGE, { recursive: true });

  // dist/ — skip *.map
  log('copying dist/ (stripping source maps)');
  copyDir(
    path.join(BACKEND, 'dist'),
    path.join(STAGE, 'dist'),
    (_p, entry) => !(entry.isFile() && entry.name.endsWith('.map'))
  );

  // prisma/ — only schema + migrations, drop seed.ts and any local db files
  log('copying prisma/ (schema + migrations only)');
  fs.mkdirSync(path.join(STAGE, 'prisma'), { recursive: true });
  fs.copyFileSync(
    path.join(BACKEND, 'prisma', 'schema.prisma'),
    path.join(STAGE, 'prisma', 'schema.prisma'),
  );
  const migrationsSrc = path.join(BACKEND, 'prisma', 'migrations');
  if (fs.existsSync(migrationsSrc)) {
    copyDir(migrationsSrc, path.join(STAGE, 'prisma', 'migrations'));
  }

  // public/ — built admin + terminal (skip if absent so dev builds still work)
  const publicSrc = path.join(BACKEND, 'public');
  if (fs.existsSync(publicSrc)) {
    log('copying public/');
    copyDir(publicSrc, path.join(STAGE, 'public'));
  } else {
    log('public/ not present, skipping');
  }

  // package.json — needed by `npm ci --omit=dev`
  log('copying package.json + package-lock.json');
  fs.copyFileSync(
    path.join(BACKEND, 'package.json'),
    path.join(STAGE, 'package.json'),
  );
  const lockSrc = path.join(BACKEND, 'package-lock.json');
  if (fs.existsSync(lockSrc)) {
    fs.copyFileSync(lockSrc, path.join(STAGE, 'package-lock.json'));
  }

  log('copying .env.template');
  fs.copyFileSync(
    path.join(BACKEND, '.env.template'),
    path.join(STAGE, '.env'),
  );

  // Production-only node_modules
  log('installing production dependencies (npm ci --omit=dev)');
  const installCmd = fs.existsSync(path.join(STAGE, 'package-lock.json'))
    ? 'npm ci --omit=dev'
    : 'npm install --omit=dev';
  execSync(installCmd, { cwd: STAGE, stdio: 'inherit' });

  // Re-run Prisma client generation against the staged schema so the
  // production node_modules contains the engine binaries.
  log('generating Prisma client in staged node_modules');
  execSync('npx prisma generate --schema prisma/schema.prisma', {
    cwd: STAGE,
    stdio: 'inherit',
  });

  const bcryptBinary = path.join(
  STAGE,
  "node_modules",
  "bcrypt",
  "lib",
  "binding",
  "napi-v3",
  "bcrypt_lib.node"
);

if (!fs.existsSync(bcryptBinary)) {
  throw new Error(
    "bcrypt native binary was not installed correctly."
  );
}

  //copy ecosystem.config.js
  log("Copying ecosystem.config.js");

  fs.copyFileSync(
    path.join(CONTROL_PANEL, "ecosystem.config.js"),
    path.join(RUNTIME, "ecosystem.config.js")
  );

  log("Generating runtime manifest");

  const backendPkg = require(path.join(BACKEND, "package.json"));
  const controlPanelPkg = require(path.join(CONTROL_PANEL, "package.json"));

  const manifest = {
    controlPanelVersion: controlPanelPkg.version,
    backendVersion: backendPkg.version,

    buildDate: new Date().toISOString(),

    runtime: {
      backend: "backend",
      node: "node",
      ecosystem: "ecosystem.config.js"
    }
  };

  fs.writeFileSync(
    path.join(RUNTIME, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  const required = [
    "dist/server.js",
    "package.json",
    "node_modules",
    "prisma/schema.prisma"
  ];

  for (const item of required) {
    const p = path.join(STAGE, item);

    if (!fs.existsSync(p)) {
      throw new Error(`Missing ${item}`);
    }
  }

  log('stage complete');
}

try {
  main();
} catch (err) {
  process.stderr.write(`[stage-backend] FAILED: ${err.message}\n`);
  process.exit(1);
}
