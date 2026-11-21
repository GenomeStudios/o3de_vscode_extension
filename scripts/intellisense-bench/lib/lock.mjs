// ============================================================================
//  lock.mjs - one benchmark run at a time per work directory
//
//  Two runs sharing <workDir> would trample each other: --cold deletes .cache under
//  the other run's live clangd, both clangds write one index, both share <workDir>/tmp,
//  and they skew each other's timings. So a run that starts clangd takes
//  <workDir>/.bench.lock first and gives it back when it ends.
//
//    * The lock is a file made with the "wx" flag, which fails if it already exists,
//      so taking it is atomic.
//    * It holds {pid, startedAt, argv, recipe}. A lock whose pid is no longer running
//      (a crashed or killed run) is stale and is cleared automatically.
//    * A lock we cannot read is treated as live and the message says how to remove it.
//    * pid reuse after a hard kill can make a stale lock look live; the message tells
//      the owner to delete the file by hand in that case.
// ============================================================================

import fs from "node:fs";
import { assertInside, normalizePath } from "./paths.mjs";

export const LOCK_FILE_NAME = ".bench.lock";

/** @type {Set<string>} lock files this process holds */
const heldLocks = new Set();

// ============================================================================
//  HELPERS
// ============================================================================

/**
 * @param {string} workDir
 * @returns {string} <workDir>/.bench.lock
 */
export function lockPathFor(workDir) {
  const lockPath = normalizePath(`${workDir}/${LOCK_FILE_NAME}`);
  assertInside(workDir, lockPath);
  return lockPath;
}

/**
 * Is a process with this pid running? (signal 0 only tests; it sends nothing.)
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists, but we may not signal it
  }
}

/**
 * @param {string} lockPath
 * @returns {{pid: number, startedAt?: string, recipe?: string} | null} null when missing or unreadable
 */
function readLock(lockPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return Number.isInteger(owner?.pid) ? owner : null;
  } catch {
    return null;
  }
}

// ============================================================================
//  TAKING AND GIVING BACK
// ============================================================================

/**
 * Take the run lock for a work directory, or throw when another live run holds it.
 * @param {string} workDir
 * @param {{recipe?: string}} [info]  written into the lock file, shown to whoever is refused
 * @returns {string} the lock file path, to hand to releaseRunLock()
 */
export function acquireRunLock(workDir, info = {}) {
  const lockPath = lockPathFor(workDir);
  fs.mkdirSync(workDir, { recursive: true });
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv.slice(1), ...info };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(owner, null, 2) + "\n", { flag: "wx" });
      heldLocks.add(lockPath);
      return lockPath;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    const holder = readLock(lockPath);
    if (!fs.existsSync(lockPath)) continue; // released between our two looks: try again
    if (!holder) {
      throw new Error(`workDir ${workDir} has a lock file ${lockPath} that cannot be read. If no bench run is using the folder, delete that file by hand.`);
    }
    if (isProcessAlive(holder.pid)) {
      throw new Error(
        `workDir ${workDir} is in use by bench pid ${holder.pid} (started ${holder.startedAt ?? "unknown"}, recipe ${holder.recipe ?? "unknown"}). ` +
          `Wait for it or use another workDir. If that run is gone (a reused pid), delete ${lockPath} by hand.`,
      );
    }
    // stale: its run died without cleaning up. Look once more right before deleting,
    // so a lock another run just took in its place is not removed.
    if (readLock(lockPath)?.pid === holder.pid) fs.rmSync(lockPath, { force: true });
  }
  throw new Error(`Could not take the run lock ${lockPath}: another run keeps taking it`);
}

/**
 * Give the lock back. A lock that names another pid is left alone.
 * @param {string} lockPath
 */
export function releaseRunLock(lockPath) {
  heldLocks.delete(lockPath);
  if (readLock(lockPath)?.pid === process.pid) fs.rmSync(lockPath, { force: true });
}

/** Release every lock this process holds. Synchronous, so it can run in an "exit" handler. */
export function releaseAllLocks() {
  for (const lockPath of [...heldLocks]) {
    try {
      releaseRunLock(lockPath);
    } catch {
      // nothing more to do while exiting
    }
  }
}
