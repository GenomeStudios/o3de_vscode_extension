// ============================================================================
//  MCP progress numbering (#33) -- o3de_build waitForEditorExit streams progress
//  while it waits for the Editor, then the build streams more on the SAME
//  progress token. MCP requires `progress` to increase across the whole call, so
//  both phases must share one count instead of each restarting at 1.
//
//  The real wait and hold functions run against a fake request context (it
//  records the notifications), a scripted process probe and a short heartbeat,
//  so no Editor, project or build is needed.
// ============================================================================

import * as assert from "assert";
import { holdUntilDone, waitForEditorExit } from "../mcp/serverImpl";

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
