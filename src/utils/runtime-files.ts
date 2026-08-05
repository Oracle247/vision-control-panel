import { app } from "electron";
import path from "path";

export class RuntimePaths {

  static runtime() {
    return path.join(process.resourcesPath, "runtime");
  }

  static backend() {
    return app.isPackaged
      ? path.join(this.runtime(), "backend")
      : path.resolve(__dirname, "../../../vfc-backend");
  }

  static node() {
    return app.isPackaged
      ? path.join(this.runtime(), "node")
      : path.resolve(__dirname, "../../node-runtime");
  }

  static ecosystem() {
    return app.isPackaged
      ? path.join(this.runtime(), "ecosystem.config.js")
      : path.resolve(__dirname, "../../ecosystem.config.js");
  }

  static manifest() {
    return path.join(this.runtime(), "manifest.json");
  }
}