// ============================================================================
//  monitorLaunch (issue #43) -- the settle report behind o3de_run's
//  settleSeconds: state, waited time, the target's log tail, whether that log
//  is stale, and error.log when it was written since the launch. Runs against
//  a temp project folder (<project>/user/log/...); the process cases launch a
//  short-lived `node` child through the real runManager.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { monitorLaunch } from "../build/runQuery";
import * as runManager from "../build/runManager";

suite("monitorLaunch", function () {
  this.timeout(15_000);

  let project: string;

  setup(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-monitor-"));
  });

  teardown(async () => {
    await runManager.stop(project); // no tracked child may outlive the test
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // ---- Helpers -------------------------------------------------------------
  /** Write <project>/user/log/<name> and set its last-write time (seconds-sized margins keep filesystems honest). */
  function writeLog(name: string, content: string, modifiedMsAgo: number): void {
    const dir = path.join(project, "user", "log");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, "utf8");
    const mtime = new Date(Date.now() - modifiedMsAgo);
    fs.utimesSync(file, mtime, mtime);
  }

  /** Launch a node child that exits after `lifetimeMs`, tracked by the runManager like an Editor launch. */
  function launchChild(lifetimeMs: number): void {
    const pid = runManager.launch(project, "node", ["-e", `setTimeout(() => {}, ${lifetimeMs})`], os.tmpdir(), "monitor-test");
    assert.ok(pid > 0, "node must be on PATH for the process cases");
  }

  const MINUTE = 60_000;

  // ---- The app is not running (returns at once) ----------------------------
  suite("no tracked process", () => {
    test("reports exited at once, with a log written before the launch marked stale", async () => {
      writeLog("Editor.log", "one\ntwo\n", MINUTE);
      const started = Date.now();
      const monitor = await monitorLaunch(project, "Editor", 5, Date.now());
      assert.ok(Date.now() - started < 1_000, "an exited app is not waited on");
      assert.strictEqual(monitor.state, "exited");
      assert.ok(monitor.waitedSeconds < 1);
      assert.strictEqual(monitor.log?.exists, true);
      assert.strictEqual(monitor.log?.kind, "editor");
      assert.strictEqual(monitor.log?.tail, "one\ntwo");
      assert.strictEqual(monitor.stale, true);
    });

    test("a log written after the launch is not stale", async () => {
      writeLog("Editor.log", "fresh\n", 0);
      const monitor = await monitorLaunch(project, "Editor", 5, Date.now() - MINUTE);
      assert.strictEqual(monitor.stale, false);
    });

    test("a missing log is reported as not existing, and is not stale", async () => {
      const monitor = await monitorLaunch(project, "Editor", 5, Date.now());
      assert.strictEqual(monitor.log?.exists, false);
      assert.strictEqual(monitor.stale, false);
    });

    test("the GameLauncher reads Game.log, not Editor.log", async () => {
      writeLog("Editor.log", "editor line\n", 0);
      writeLog("Game.log", "game line\n", 0);
      const monitor = await monitorLaunch(project, "GameLauncher", 5, Date.now() - MINUTE);
      assert.strictEqual(monitor.log?.kind, "game");
      assert.strictEqual(monitor.log?.tail, "game line");
    });

    test("a custom exe has no known log: log is null and nothing is stale or flagged", async () => {
      writeLog("Editor.log", "x\n", 0);
      writeLog("error.log", "boom\n", 0);
      const monitor = await monitorLaunch(project, "MyTool", 5, Date.now() - MINUTE);
      assert.strictEqual(monitor.log, null);
      assert.strictEqual(monitor.stale, false);
      assert.strictEqual(monitor.errorLog, undefined);
      assert.strictEqual(monitor.state, "exited");
    });

    test("an error.log written since the launch is reported with its tail", async () => {
      writeLog("error.log", "crash line 1\ncrash line 2\n", 0);
      const monitor = await monitorLaunch(project, "Editor", 5, Date.now() - MINUTE);
      assert.strictEqual(monitor.errorLog?.exists, true);
      assert.strictEqual(monitor.errorLog?.kind, "error");
      assert.strictEqual(monitor.errorLog?.tail, "crash line 1\ncrash line 2");
    });

    test("an error.log from before the launch is not reported", async () => {
      writeLog("error.log", "old crash\n", MINUTE);
      const monitor = await monitorLaunch(project, "Editor", 5, Date.now());
      assert.strictEqual(monitor.errorLog, undefined);
    });

    test("with no error.log, none is reported", async () => {
      const monitor = await monitorLaunch(project, "Editor", 5, Date.now());
      assert.strictEqual(monitor.errorLog, undefined);
    });
  });

  // ---- The app is running ---------------------------------------------------
  suite("tracked process", () => {
    test("still running at the deadline: state running after about the settle time", async () => {
      launchChild(8_000);
      const monitor = await monitorLaunch(project, "Editor", 1, Date.now());
      assert.strictEqual(monitor.state, "running");
      assert.ok(monitor.waitedSeconds >= 0.9 && monitor.waitedSeconds < 3, `waited ${monitor.waitedSeconds}s`);
    });

    test("an app that exits inside the window ends the wait early with state exited", async () => {
      launchChild(700);
      const monitor = await monitorLaunch(project, "Editor", 10, Date.now());
      assert.strictEqual(monitor.state, "exited");
      assert.ok(monitor.waitedSeconds < 5, `waited ${monitor.waitedSeconds}s of 10`);
    });

    test("an aborted signal ends the wait at once while the app is still running", async () => {
      launchChild(8_000);
      const controller = new AbortController();
      controller.abort();
      const started = Date.now();
      const monitor = await monitorLaunch(project, "Editor", 10, Date.now(), controller.signal);
      assert.ok(Date.now() - started < 1_000, "an aborted wait returns immediately");
      assert.strictEqual(monitor.state, "running");
    });
  });
});
