import { join } from "node:path";
import { spawn } from "node:child_process";
import { logger } from "../logger.js";
import { v4 as uuid } from "uuid";
import {
  getAppPath,
  UPLOAD_DIR,
  APPS_DIR,
  SCRIPTS_DIR,
  TMP_DIR,
} from "./getAppPath.js";

const ADB_EXE = process.env.ADB_EXE || process.env.ADB || "adb";
const configuredMediaAdbTimeout = Number(process.env.MEDIA_ADB_TIMEOUT_MS);
export const MEDIA_ADB_TIMEOUT_MS =
  Number.isSafeInteger(configuredMediaAdbTimeout) &&
  configuredMediaAdbTimeout > 0
    ? configuredMediaAdbTimeout
    : 5 * 60 * 1000;
const MEDIA_ADB_CONTROL_TIMEOUT_MS = Math.min(MEDIA_ADB_TIMEOUT_MS, 15_000);

export class AdbShellService {
  runAdbCommand(commandArgs, label, { timeoutMs = 0 } = {}) {
    const log = {
      logs: [],
      errors: [],
      finished: false,
    };
    return new Promise((resolve, reject) => {
      const child = spawn(ADB_EXE, commandArgs);
      let settled = false;
      let timeout;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        callback(value);
      };

      child.stdout.on("data", (data) => {
        const msg = data.toString();
        log.logs.push(msg);
      });
      child.stderr.on("data", (data) => {
        const msg = data.toString();
        logger.error(msg);
        log.errors.push(msg);
      });
      child.on("error", (error) => finish(reject, error));
      child.on("exit", (code) => {
        logger.info(label);
        log.finished = true;
        if (code === 0) {
          finish(resolve, log);
        } else {
          finish(reject, log);
        }
      });

      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          const error = new Error(`ADB command timed out after ${timeoutMs} ms`);
          error.code = "ADB_COMMAND_TIMEOUT";
          error.logs = log;
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may have exited between the timer and this callback.
          }
          finish(reject, error);
        }, timeoutMs);
      }
    });
  }

  async screenOff(device = null) {
    const startArgs = device ? ["-s", device] : [];
    const commands = [
      [...startArgs, "shell", "input", "keyevent", "SLEEP"],
      [...startArgs, "shell", "input", "keyevent", "223"],
    ];
    let lastError;
    for (const commandArgs of commands) {
      try {
        return await this.runAdbCommand(commandArgs, "SCREEN OFF FINISHED!");
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async assertDevice(device) {
    return this.runAdbCommand(
      ["-s", device, "get-state"],
      `DEVICE ${device} IS CONNECTED`,
      { timeoutMs: MEDIA_ADB_CONTROL_TIMEOUT_MS },
    );
  }

  async ensureRemoteDirectory(device, directory) {
    return this.runAdbCommand(
      ["-s", device, "shell", "mkdir", "-p", directory],
      `DIRECTORY ${directory} IS READY`,
      { timeoutMs: MEDIA_ADB_CONTROL_TIMEOUT_MS },
    );
  }

  async pushMediaFile(device, localPath, remotePath) {
    const pushed = await this.runAdbCommand(
      ["-s", device, "push", localPath, remotePath],
      `MEDIA PUSHED TO ${remotePath}`,
      { timeoutMs: MEDIA_ADB_TIMEOUT_MS },
    );

    try {
      await this.runAdbCommand(
        [
          "-s",
          device,
          "shell",
          "am",
          "broadcast",
          "-a",
          "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
          "-d",
          `file://${remotePath}`,
        ],
        `MEDIA SCANNED AT ${remotePath}`,
        { timeoutMs: MEDIA_ADB_CONTROL_TIMEOUT_MS },
      );
      return { logs: pushed.logs, scanned: true };
    } catch {
      return {
        logs: pushed.logs,
        scanned: false,
        warning: "File copied, but Android media library refresh failed",
      };
    }
  }

  async install(app = "de.heinekingmedia.stashcat.apk", device = null, source) {
    const installArgs = device ? ["-s", device] : [];
    const appPath = getAppPath(source, app);
    const commandArgs = [...installArgs, "install", appPath];
    console.log("COMMAND ARGS =", commandArgs);

    const log = {
      logs: [],
      errors: [],
      finished: false,
    };
    const result = await new Promise((resolve, reject) => {
      const child = spawn("adb", commandArgs);
      child.stdout.on("data", (data) => {
        const msg = data.toString();
        log.logs.push(msg);
      });
      child.stderr.on("data", (data) => {
        const msg = data.toString();
        logger.error(msg);
        log.errors.push(msg);
        reject(log);
      });
      child.on("exit", () => {
        logger.info("INSTALL FINISHED!");
        log.finished = true;
        resolve(log);
      });
    });
    return result;
  }

  async installMultiple(
    app = "de.heinekingmedia.stashcat.apkm",
    device = null,
    source
  ) {
    const temp = uuid().toString();
    const parts = app.split(".");
    const appPath = source === "uploads" ? UPLOAD_DIR : APPS_DIR;
    let extension;
    let filename;
    if (parts?.length) {
      extension = parts[parts.length - 1];
      filename = parts.slice(0, -1).join(".");
    }

    const deviceArg = device ? `-s ${device}` : "";

    // unzip
    // adb -s device install-multiple *.apk
    const commandArgs = [
      join(SCRIPTS_DIR, "adb-extract-and-install-multiple.sh"),
      appPath,
      filename,
      extension,
      join(TMP_DIR, temp),
      deviceArg,
    ];
    const log = {
      logs: [],
      errors: [],
      finished: false,
    };
    const result = await new Promise((resolve, reject) => {
      const child = spawn("bash", commandArgs);
      child.stdout.on("data", (data) => {
        const msg = data.toString();
        log.logs.push(msg);
      });
      child.stderr.on("data", (data) => {
        const msg = data.toString();
        logger.error(msg);
        log.errors.push(msg);
        reject(log);
      });
      child.on("exit", () => {
        logger.info("INSTALL BUNDLE FINISHED!");
        log.finished = true;
        resolve(log);
      });
    });

    return result;
  }

  async start(app = "de.heinekingmedia.stashcat.apk", device = null, source) {
    const deviceArg = device ? `-s ${device}` : "";
    const appPath = getAppPath(source, app);
    // adb shell am start-activity --user 0 de.heinekingmedia.stashcat/.start.StartActivity
    const commandArgs = [
      join(SCRIPTS_DIR, "aapt2-extract-and-start-activity.sh"),
      appPath,
      deviceArg,
    ];
    const log = {
      logs: [],
      errors: [],
      finished: false,
    };
    const result = await new Promise((resolve, reject) => {
      const child = spawn("bash", commandArgs);
      child.stdout.on("data", (data) => {
        const msg = data.toString();
        log.logs.push(msg);
      });
      child.stderr.on("data", (data) => {
        const msg = data.toString();
        logger.error(msg);
        log.errors.push(msg);
        reject(log);
      });
      child.on("exit", () => {
        logger.info("START FINISHED!");
        log.finished = true;
        resolve(log);
      });
    });

    return result;
  }

  async pin(app = "de.heinekingmedia.stashcat.apk", device = null, source) {
    const deviceArg = device ? `-s ${device}` : "";
    const appPath = getAppPath(source, app);
    // adb shell am task lock $(adb shell dumpsys activity recents | grep "Recent #.*de\.heinekingmedia\.stashcat" | cut -d '#' -f 3 | cut -d ' ' -f 1)
    const commandArgs = [
      join(SCRIPTS_DIR, "aapt2-extract-and-pin.sh"),
      appPath,
      deviceArg,
    ];
    const log = {
      logs: [],
      errors: [],
      finished: false,
    };
    const result = await new Promise((resolve, reject) => {
      const child = spawn("bash", commandArgs);
      child.stdout.on("data", (data) => {
        const msg = data.toString();
        log.logs.push(msg);
      });
      child.stderr.on("data", (data) => {
        const msg = data.toString();
        logger.error(msg);
        log.errors.push(msg);
        reject(log);
      });
      child.on("exit", () => {
        logger.error("PIN FINISHED!");
        log.finished = true;
        resolve(log);
      });
    });

    return result;
  }

  async unpin(app = "de.heinekingmedia.stashcat.apk", device = null) {
    const startArgs = device ? ["-s", device] : [];
    // adb shell am task lock stop
    const commandArgs = [...startArgs, "shell", "am", "task", "lock", "stop"];
    const log = {
      logs: [],
      errors: [],
      finished: false,
    };
    const result = await new Promise((resolve, reject) => {
      const child = spawn("adb", commandArgs);
      child.stdout.on("data", (data) => {
        const msg = data.toString();
        log.logs.push(msg);
      });
      child.stderr.on("data", (data) => {
        const msg = data.toString();
        logger.error(msg);
        log.errors.push(msg);
        reject(log);
      });
      child.on("exit", () => {
        logger.info("UNPIN FINISHED!");
        log.finished = true;
        resolve(log);
      });
    });
    return result;
  }
}

export const service = new AdbShellService();
