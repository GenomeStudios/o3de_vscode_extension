// ============================================================================
//  MCP progress numbering (#33) -- o3de_build waitForEditorExit streams progress
//  while it waits for the Editor, then the build streams more on the SAME
//  progress token. MCP requires `progress` to increase across the whole call, so
//  both phases must share one count instead of each restarting at 1.
//  Also the health tool's budget choice and heartbeats (the end of this file).
//
//  The real wait and hold functions run against a fake request context (it
//  records the notifications), a scripted process probe and a short heartbeat,
//  so no Editor, project or build is needed.
// ============================================================================

import * as assert from "assert";
import type { BuildOptions } from "../build/buildOptions";
import type { HealthOutcome, HealthReport } from "../intellisense/healthModel";
import type { HealthEnvironment, HealthRequest, HealthRun, startHealthCheck } from "../intellisense/healthQuery";
import { healthSummaryLine } from "../intellisense/healthReport";
import { holdUntilDone, runIntellisenseHealthTool, waitForEditorExit } from "../mcp/serverImpl";

type Extra = Parameters<typeof waitForEditorExit>[0];
type Job = Parameters<typeof holdUntilDone>[1];

const HEARTBEAT_MS = 10;

// ---- Fakes -----------------------------------------------------------------
/** A request context with a progress token that records every progress number it is sent. */
function fakeExtra(sent: number[]): Extra {
  return {
    _meta: { progressToken: "token" },
    signal: new AbortController().signal,
    sendNotification: async (notification: { params: { progress: number } }) => {
      sent.push(notification.params.progress);
    },
  } as unknown as Extra;
}

/** A job that finishes after `ms`. */
function jobFinishingIn(ms: number): Job {
  const job: Job = { startedAt: Date.now(), result: undefined, done: Promise.resolve() };
  job.done = new Promise<void>((resolve) =>
    setTimeout(() => {
      job.result = {};
      resolve();
    }, ms),
  );
  return job;
}

const increasing = (sent: number[]): number[] => sent.map((_, index) => index + 1);

// ---- The tests ---------------------------------------------------------------
suite("MCP progress numbering (wait, then build)", () => {
  test("the wait for the Editor and the build after it share one strictly increasing count", async function () {
    this.timeout(15_000);
    const sent: number[] = [];
    const extra = fakeExtra(sent);
    const progress = { step: 0 };

    // The Editor is open for two looks, then closes.
    let looks = 0;
    const probe = async (): Promise<string[]> => (looks++ < 2 ? ["Editor.exe"] : []);

    const refusal = await waitForEditorExit(extra, 1, progress, probe, HEARTBEAT_MS);
    assert.strictEqual(refusal, undefined, "the Editor closed: build now");
    const sentByWait = sent.length;
    assert.ok(sentByWait >= 1, "the wait streamed progress");

    await holdUntilDone(extra, jobFinishingIn(120), (seconds) => `Building… ${seconds}s`, progress, HEARTBEAT_MS);
    assert.ok(sent.length > sentByWait, "the build streamed progress too");
    assert.deepStrictEqual(sent, increasing(sent), "1, 2, 3 ... and the build did not restart at 1");
  });

  test("a call that never waited (configure) counts from 1", async () => {
    const sent: number[] = [];
    await holdUntilDone(fakeExtra(sent), jobFinishingIn(60), (seconds) => `Configuring… ${seconds}s`, undefined, HEARTBEAT_MS);
    assert.ok(sent.length >= 1);
    assert.deepStrictEqual(sent, increasing(sent));
  });
});

// ---- The health tool's budget and heartbeats ----------------------------------
//  o3de_intellisense_health picks its time budget from whether the client sent a progress
//  token, and streams "N of M files checked" heartbeats while it waits. The real handler runs
//  against a fake request context and a fake check, so no project or clangd is needed.
//  The tool's end-to-end test (mcpIntelliSenseHealth.test.ts) only has the instant no-project refusal.

const MESSAGE_FRAME = "Checking IntelliSense health...";

interface Heartbeat {
  progress: number;
  message: string;
}

/** A request context that records every heartbeat's number and message; `withToken` false is a client that sent no progress token. */
function recordingExtra(sent: Heartbeat[], withToken = true): Extra {
  return {
    _meta: withToken ? { progressToken: "token" } : {},
    signal: new AbortController().signal,
    sendNotification: async (notification: { params: Heartbeat }) => {
      sent.push({ progress: notification.params.progress, message: notification.params.message });
    },
  } as unknown as Extra;
}

const REPORT: HealthReport = {
  extensionVersion: "1.2.3",
  platform: "win32",
  project: { name: "Game", path: "D:/game" },
  intellisenseEngine: "clangd",
  clangd: { found: true, path: "clangd", source: "path", version: "22.1.6" },
  database: {
    dir: "D:/game/build/clangd",
    file: "D:/game/build/clangd/compile_commands.json",
    kind: "generated",
    inUse: true,
    exists: true,
    entries: 10,
    origins: { project: 10, gem: 0, engineFramework: 0, engineGems: 0, fallback: 0 },
    includeDirs: { checked: 1, missing: 0, inBuildFolder: 0, examples: [] },
  },
  engine: { mode: "native", coverage: "participating" },
  files: [],
  summary: { sampled: 6, clean: 6, withErrors: 0, notChecked: 0, withoutEntry: 0 },
  findings: [],
};

interface StartCall {
  env: HealthEnvironment;
  request: HealthRequest;
}

/** A check that "runs" for `ms`, counts its files up to 6, then resolves with `outcome` (or rejects with an Error). */
function fakeStart(calls: StartCall[], outcome: HealthOutcome | Error, ms = 120): typeof startHealthCheck {
  return (_options, env, request = {}) => {
    calls.push({ env, request });
    const run: HealthRun = { startedAt: Date.now(), progress: { checked: 0, total: 6 }, done: Promise.resolve({ ok: true, report: REPORT }) };
    run.done = new Promise<HealthOutcome>((resolve, reject) =>
      setTimeout(() => {
        if (outcome instanceof Error) {
          reject(outcome);
          return;
        }
        run.progress.checked = 6;
        run.result = outcome;
        resolve(outcome);
      }, ms),
    );
    return run;
  };
}

const OPTIONS = { buildOptions: {} as BuildOptions, version: "1.2.3", globalStorageRoot: "D:/globalStorage" };
const run = (args: Parameters<typeof runIntellisenseHealthTool>[0], extra: Extra, start: typeof startHealthCheck) =>
  runIntellisenseHealthTool(args, extra, OPTIONS, start, HEARTBEAT_MS);

suite("MCP IntelliSense health tool: budget and heartbeats", () => {
  test("a client with a progress token gets the 5-minute budget and 'N of M files checked' heartbeats counting up from 1", async function () {
    this.timeout(15_000);
    const sent: Heartbeat[] = [];
    const calls: StartCall[] = [];
    await run({ sampleSize: 4, includeEntryless: false }, recordingExtra(sent), fakeStart(calls, { ok: true, report: REPORT }));

    assert.strictEqual(calls[0].request.maxTotalMs, 300_000);
    assert.strictEqual(calls[0].request.sampleSize, 4);
    assert.strictEqual(calls[0].request.includeEntryless, false);
    assert.deepStrictEqual(calls[0].env, { extensionVersion: "1.2.3", globalStorageRoot: "D:/globalStorage" });
    assert.ok(sent.length >= 2, `heartbeats sent: ${sent.length}`);
    assert.deepStrictEqual(sent.map((beat) => beat.progress), increasing(sent.map((beat) => beat.progress)));
    for (const beat of sent) {
      assert.ok(beat.message.startsWith(MESSAGE_FRAME), beat.message);
      assert.match(beat.message, /\d+ of 6 files checked, \d+s elapsed/);
    }
  });

  test("a client without a progress token gets the 45-second budget and no heartbeats", async function () {
    this.timeout(15_000);
    const sent: Heartbeat[] = [];
    const calls: StartCall[] = [];
    await run({}, recordingExtra(sent, false), fakeStart(calls, { ok: true, report: REPORT }));
    assert.strictEqual(calls[0].request.maxTotalMs, 45_000);
    assert.deepStrictEqual(sent, []);
  });

  test("a finished check comes back as the summary line, then the outcome JSON — not an error", async function () {
    this.timeout(15_000);
    const result = await run({}, recordingExtra([]), fakeStart([], { ok: true, report: REPORT }));
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.content.length, 2);
    assert.strictEqual(result.content[0].text, healthSummaryLine(REPORT));
    const outcome = JSON.parse(result.content[1].text) as { ok: boolean; report: HealthReport };
    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(outcome.report, REPORT);
  });

  test("the request's abort signal reaches the check", async function () {
    this.timeout(15_000);
    const calls: StartCall[] = [];
    const extra = recordingExtra([]);
    await run({}, extra, fakeStart(calls, { ok: true, report: REPORT }));
    assert.strictEqual(calls[0].request.signal, extra.signal);
  });

  test("a refusal (no project) is an error result carrying its message", async function () {
    this.timeout(15_000);
    const refusal: HealthOutcome = { ok: false, reason: "noProject", message: "No O3DE project is open in this workspace, so there is no compile database to check." };
    const result = await run({}, recordingExtra([]), fakeStart([], refusal, 20));
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content[0].text, refusal.message);
    assert.deepStrictEqual(JSON.parse(result.content[1].text), refusal);
  });

  test("an unexpected failure of the check is an error result with its message, never a rejected call", async function () {
    this.timeout(15_000);
    const result = await run({}, recordingExtra([]), fakeStart([], new Error("spawn EINVAL"), 20));
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /The IntelliSense health check failed: spawn EINVAL/);

    const throwsAtOnce = (() => {
      throw new Error("could not start");
    }) as unknown as typeof startHealthCheck;
    const early = await run({}, recordingExtra([]), throwsAtOnce);
    assert.strictEqual(early.isError, true);
    assert.match(early.content[0].text, /could not start/);
  });
});
