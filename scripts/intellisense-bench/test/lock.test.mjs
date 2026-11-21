import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireRunLock, isProcessAlive, lockPathFor, releaseAllLocks, releaseRunLock } from "../lib/lock.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoots = [];
function makeWorkDir() {
  const root = fs.mkdtempSync(path.join(here, ".tmp-lock-")).split("\\").join("/");
  tmpRoots.push(root);
  return root;
}
after(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** The pid of a process that has already exited. */
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

/** The test runner (our parent) is alive for the whole test, and is not this process. */
const otherLivePid = process.ppid;

const writeLock = (lockPath, owner) => fs.writeFileSync(lockPath, typeof owner === "string" ? owner : JSON.stringify(owner));
const readOwner = (lockPath) => JSON.parse(fs.readFileSync(lockPath, "utf8"));

// ============================================================================
//  taking and giving back
// ============================================================================

test("lockPathFor: <workDir>/.bench.lock", () => {
  assert.equal(lockPathFor("D:/ib"), "D:/ib/.bench.lock");
  assert.equal(lockPathFor("D:\\ib\\"), "D:/ib/.bench.lock");
});

test("acquire writes the owner, release removes the file, and the lock can be taken again", () => {
  const work = makeWorkDir();
  const lockPath = acquireRunLock(work, { recipe: "gs_play" });
  assert.equal(lockPath, `${work}/.bench.lock`);

  const owner = readOwner(lockPath);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.recipe, "gs_play");
  assert.ok(Array.isArray(owner.argv));
  assert.ok(!Number.isNaN(Date.parse(owner.startedAt)));

  releaseRunLock(lockPath);
  assert.equal(fs.existsSync(lockPath), false);
  releaseRunLock(acquireRunLock(work)); // free again
});

test("a second acquire throws while the first is held, and names the holder", () => {
  const work = makeWorkDir();
  const lockPath = acquireRunLock(work, { recipe: "first" });
  assert.throws(
    () => acquireRunLock(work, { recipe: "second" }),
    (err) => {
      assert.match(err.message, new RegExp(`in use by bench pid ${process.pid} \\(started .+, recipe first\\)`));
      assert.match(err.message, /Wait for it or use another workDir/);
      return true;
    },
  );
  assert.equal(readOwner(lockPath).recipe, "first", "the refused attempt leaves the holder's lock alone");
  releaseRunLock(lockPath);
});

test("a lock held by another live process is refused", () => {
  const work = makeWorkDir();
  const lockPath = lockPathFor(work);
  writeLock(lockPath, { pid: otherLivePid, startedAt: "2026-11-21T10:00:00.000Z", recipe: "other" });
  assert.throws(() => acquireRunLock(work), new RegExp(`in use by bench pid ${otherLivePid} \\(started 2026-11-21T10:00:00.000Z, recipe other\\)`));
  assert.equal(fs.existsSync(lockPath), true);
});

test("a lock naming a dead pid is stale: it is reclaimed", () => {
  const work = makeWorkDir();
  const lockPath = lockPathFor(work);
  const dead = deadPid();
  assert.equal(isProcessAlive(dead), false);
  writeLock(lockPath, { pid: dead, startedAt: "2026-11-21T10:00:00.000Z", recipe: "crashed" });

  assert.equal(acquireRunLock(work, { recipe: "fresh" }), lockPath);
  assert.equal(readOwner(lockPath).pid, process.pid);
  assert.equal(readOwner(lockPath).recipe, "fresh");
  releaseRunLock(lockPath);
});

test("a lock that cannot be read is treated as live, and the message says to delete it by hand", () => {
  const work = makeWorkDir();
  const lockPath = lockPathFor(work);
  writeLock(lockPath, "not json at all");
  assert.throws(() => acquireRunLock(work), /cannot be read.*delete that file by hand/);
  writeLock(lockPath, { no: "pid" });
  assert.throws(() => acquireRunLock(work), /cannot be read/);
  assert.equal(fs.existsSync(lockPath), true, "it is never deleted automatically");
});

test("release leaves a lock that names another pid alone", () => {
  const work = makeWorkDir();
  const lockPath = lockPathFor(work);
  writeLock(lockPath, { pid: otherLivePid, recipe: "theirs" });
  releaseRunLock(lockPath);
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(readOwner(lockPath).recipe, "theirs");
});

test("release of a lock that is already gone is not an error", () => {
  const work = makeWorkDir();
  const lockPath = acquireRunLock(work);
  fs.rmSync(lockPath);
  assert.doesNotThrow(() => releaseRunLock(lockPath));
});

test("releaseAllLocks gives back every lock this process holds (the exit handler's job)", () => {
  const first = acquireRunLock(makeWorkDir());
  const second = acquireRunLock(makeWorkDir());
  releaseAllLocks();
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
  assert.doesNotThrow(() => releaseAllLocks(), "safe to call again");
});

test("installCleanup gives the lock back when the process exits through process.exit (the Ctrl+C path)", () => {
  const work = makeWorkDir();
  const url = (file) => pathToFileURL(path.join(here, "..", "lib", file)).href;
  const script = [
    `import { installCleanup } from ${JSON.stringify(url("procs.mjs"))};`,
    `import { acquireRunLock } from ${JSON.stringify(url("lock.mjs"))};`,
    "installCleanup();",
    `acquireRunLock(${JSON.stringify(work)}, { recipe: "child" });`,
    "process.exit(130);",
  ].join("\n");

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 130, child.stderr);
  assert.equal(fs.existsSync(lockPathFor(work)), false, "the exit handler released the lock");
});
