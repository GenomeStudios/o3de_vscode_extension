// ============================================================================
//  procs.mjs - child-process helpers shared by the check and nav stages
//
//  Every clangd the harness starts goes through spawnTracked(), so a crash, a
//  Ctrl+C or an early exit can never leave a clangd running in the background.
// ============================================================================

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { releaseAllLocks } from "./lock.mjs";

// ============================================================================
//  TRACKED CHILDREN
// ============================================================================

/** @type {Set<import("node:child_process").ChildProcess>} */
const liveChildren = new Set();

/**
 * spawn() that remembers the child so killAll() can reach it.
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  child.once("error", () => liveChildren.delete(child));
  return child;
}

/** Kill every tracked child that is still running. Safe to call repeatedly. */
export function killAll() {
  for (const child of liveChildren) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
  liveChildren.clear();
}

/** Kill tracked children and give back run locks on normal exit, uncaught errors and Ctrl+C / termination. */
export function installCleanup() {
  process.on("exit", () => {
    killAll();
    releaseAllLocks();
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    process.on(signal, () => {
      killAll();
      process.exit(130);
    });
  }
}

// ============================================================================
//  CLANGD LOCATION AND VERSION
// ============================================================================

/**
 * Environment for a clangd child: temp files (preambles) go to <workDir>/tmp so the
 * run writes nothing outside the work directory.
 * @param {string} workDir
 * @returns {NodeJS.ProcessEnv}
 */
export function clangdEnv(workDir) {
  const tmp = path.join(workDir, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  return { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
}

/**
 * First line of "clangd --version", e.g. "clangd version 22.1.6 (...)".
 * @param {string} clangd
 * @returns {string}
 */
export function clangdVersion(clangd) {
  const result = spawnSync(clangd, ["--version"], { encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`Cannot run clangd at "${clangd}": ${result.error.message}`);
  return (result.stdout || "").split(/\r?\n/)[0].trim() || "unknown";
}

/**
 * How many clangd processes are running right now (an editor's clangd, an earlier run's ...).
 * They compete for CPU with the run, so the report records the number at the start.
 * @returns {number | null}  null when the process list could not be read
 */
export function countClangdProcesses() {
  const windows = process.platform === "win32";
  const result = windows
    ? spawnSync("tasklist", ["/FI", "IMAGENAME eq clangd.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true })
    : spawnSync("pgrep", ["-x", "clangd"], { encoding: "utf8" });
  if (result.error) return null;
  if (!windows && result.status === 1) return 0; // pgrep: no match
  return (result.stdout || "").split(/\r?\n/).filter((line) => /clangd/i.test(line)).length;
}

/**
 * Find a clangd executable: explicit path, $CLANGD, the newest copy installed by the
 * VS Code clangd extension, then PATH.
 * @param {string} [explicit]
 * @returns {string | null}
 */
export function findClangd(explicit) {
  if (explicit) return explicit;
  if (process.env.CLANGD) return process.env.CLANGD;

  const storage = process.env.APPDATA
    ? path.join(process.env.APPDATA, "Code", "User", "globalStorage", "llvm-vs-code-extensions.vscode-clangd", "install")
    : null;
  if (storage && fs.existsSync(storage)) {
    const versions = fs.readdirSync(storage).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const dir = path.join(storage, version);
      for (const sub of fs.readdirSync(dir)) {
        const exe = path.join(dir, sub, "bin", process.platform === "win32" ? "clangd.exe" : "clangd");
        if (fs.existsSync(exe)) return exe;
      }
    }
  }

  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["clangd"], { encoding: "utf8" });
  if (probe.status === 0) return probe.stdout.split(/\r?\n/)[0].trim();
  return null;
}
