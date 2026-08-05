const path = require("path");
const fs = require("fs");

const packagedBackend = path.join(__dirname, "backend");
const devBackend = path.resolve(__dirname, "..", "vfc-backend");

const BACKEND_DIR = fs.existsSync(packagedBackend)
  ? packagedBackend
  : devBackend;

const LOG_DIR =
  process.env.VCP_LOG_DIR ||
  path.join(BACKEND_DIR, "logs");

module.exports = {
  apps: [
    {
      name: "vfc-backend",
      script: path.join(BACKEND_DIR, "dist", "server.js"),
      cwd: BACKEND_DIR,

      watch: false,
      autorestart: true,
      max_restarts: 3,
      min_uptime: "10s",
      restart_delay: 5000,

      env: {
        NODE_ENV: "production",
        PORT: 3030,
      },

      error_file: path.join(LOG_DIR, "pm2-error.log"),
      out_file: path.join(LOG_DIR, "pm2-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};