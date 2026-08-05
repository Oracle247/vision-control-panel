import { app } from "electron";
import path from "node:path";
import { RuntimePaths } from "./runtime-files";

export function getNodeExecutable() {
  if (app.isPackaged) {
    return path.join(
      RuntimePaths.node(),
      process.platform === "win32" ? "node.exe" : "bin/node"
    );
  }

  return process.execPath;
}

