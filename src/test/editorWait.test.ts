// ============================================================================
//  Editor wait (issue #33) -- the poll/settle/cancel/timeout loop behind
//  "Build When Editor Closes" and o3de_build's waitForEditorExit, proven with a
//  fake probe, clock and sleep (no processes), plus the one real-timer check
//  that Cancel is not held up by the poll interval.
// ============================================================================

import * as assert from "assert";
import { describeWait, EditorWaitOptions, waitForProcessesToExit } from "../build/editorWait";

const EDITOR = "Editor.exe";
const SCRIPT_CANVAS = "ScriptCanvasApplication.exe";

// ---- Fakes -----------------------------------------------------------------
/** A probe that answers from a script, repeating the last answer, and counts its calls. */
function scriptedProbe(...answers: string[][]): { probe: () => Promise<string[]>; calls: () => number } {
  let calls = 0;
  return {
    probe: async () => answers[Math.min(calls++, answers.length - 1)],
    calls: () => calls,
  };
}

/** A clock that only moves when the fake sleep is called. */
function fakeClock(): { now: () => number; sleep: NonNullable<EditorWaitOptions["sleep"]>; sleeps: number[] } {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (!signal?.aborted) {
        time += ms;
      }
    },
    sleeps,
  };
}

/** Everything onWaiting was told, as "running@elapsed" strings. */
function recorder(): { onWaiting: (running: string[], elapsedMs: number) => void; seen: string[] } {
  const seen: string[] = [];
  return { onWaiting: (running, elapsedMs) => seen.push(`${running.join("+")}@${elapsedMs}`), seen };
}

suite("editorWait", () => {
  // ---- Clear ---------------------------------------------------------------
  suite("waitForProcessesToExit: clear", () => {
    test("nothing running: clear at once, no sleep and no settle", async () => {
      const probe = scriptedProbe([]);
      const clock = fakeClock();
      const outcome = await waitForProcessesToExit({ probe: probe.probe, now: clock.now, sleep: clock.sleep });
      assert.deepStrictEqual(outcome, { status: "clear", waitedMs: 0, running: [] });
      assert.strictEqual(probe.calls(), 1);
      assert.deepStrictEqual(clock.sleeps, []);
    });

    test("running for three polls, then gone: clear after the settle", async () => {
      const probe = scriptedProbe([EDITOR], [EDITOR], [EDITOR], [], []);
      const clock = fakeClock();
      const waiting = recorder();
      const outcome = await waitForProcessesToExit({ probe: probe.probe, now: clock.now, sleep: clock.sleep, onWaiting: waiting.onWaiting });
      assert.deepStrictEqual(outcome, { status: "clear", waitedMs: 7_500, running: [] });
      assert.deepStrictEqual(clock.sleeps, [2_000, 2_000, 2_000, 1_500], "three polls, then the settle");
      assert.strictEqual(probe.calls(), 5, "the settle looks again before clearing");
      assert.deepStrictEqual(waiting.seen, ["Editor.exe@0", "Editor.exe@2000", "Editor.exe@4000", "@7500"]);
    });

    test("the poll and settle intervals can be set", async () => {
      const probe = scriptedProbe([EDITOR], [], []);
      const clock = fakeClock();
      await waitForProcessesToExit({ probe: probe.probe, now: clock.now, sleep: clock.sleep, pollMs: 100, settleMs: 7 });
      assert.deepStrictEqual(clock.sleeps, [100, 7]);
    });

    test("an Editor relaunched during the settle keeps the wait going", async () => {
      const probe = scriptedProbe([EDITOR], [], [EDITOR], [], []);
      const clock = fakeClock();
      const waiting = recorder();
      const outcome = await waitForProcessesToExit({ probe: probe.probe, now: clock.now, sleep: clock.sleep, onWaiting: waiting.onWaiting });
      assert.strictEqual(outcome.status, "clear");
      assert.strictEqual(outcome.waitedMs, 7_000);
      assert.strictEqual(probe.calls(), 5);
      assert.deepStrictEqual(waiting.seen, ["Editor.exe@0", "Editor.exe@3500", "@7000"], "told it is still running after the relaunch");
    });

    test("two guarded processes: waits until both are gone", async () => {
      const probe = scriptedProbe([EDITOR, SCRIPT_CANVAS], [SCRIPT_CANVAS], [], []);
      const clock = fakeClock();
      const waiting = recorder();
      const outcome = await waitForProcessesToExit({ probe: probe.probe, now: clock.now, sleep: clock.sleep, onWaiting: waiting.onWaiting });
      assert.strictEqual(outcome.status, "clear");
      assert.deepStrictEqual(waiting.seen.slice(0, 2), ["Editor.exe+ScriptCanvasApplication.exe@0", "ScriptCanvasApplication.exe@2000"]);
    });
  });

  // ---- Timeout -------------------------------------------------------------
  suite("waitForProcessesToExit: timeout", () => {
    test("still running at the cap: timeout, with what was running", async () => {
      const probe = scriptedProbe([EDITOR]);
      const clock = fakeClock();
      const waiting = recorder();
      const outcome = await waitForProcessesToExit({
        probe: probe.probe,
        now: clock.now,
        sleep: clock.sleep,
        maxWaitMs: 10_000,
        onWaiting: waiting.onWaiting,
      });
      assert.deepStrictEqual(outcome, { status: "timeout", waitedMs: 10_000, running: [EDITOR] });
      assert.strictEqual(waiting.seen[waiting.seen.length - 1], "@10000", "the exit tells the UI to close");
    });

    test("the last sleep is cut short so the timeout lands on the cap", async () => {
      const clock = fakeClock();
      const outcome = await waitForProcessesToExit({
        probe: scriptedProbe([EDITOR]).probe,
        now: clock.now,
        sleep: clock.sleep,
        maxWaitMs: 5_000,
      });
      assert.deepStrictEqual(clock.sleeps, [2_000, 2_000, 1_000]);
      assert.strictEqual(outcome.waitedMs, 5_000);
    });

    test("closing before the cap is clear, not a timeout", async () => {
      const clock = fakeClock();
      const outcome = await waitForProcessesToExit({
        probe: scriptedProbe([EDITOR], [EDITOR], [], []).probe,
        now: clock.now,
        sleep: clock.sleep,
        maxWaitMs: 60_000,
      });
      assert.strictEqual(outcome.status, "clear");
    });
  });

  // ---- Cancel --------------------------------------------------------------
  suite("waitForProcessesToExit: cancel", () => {
    test("aborting during a sleep: cancelled, and no further probe", async () => {
      const probe = scriptedProbe([EDITOR]);
      const controller = new AbortController();
      const waiting = recorder();
      let sleeps = 0;
      const outcome = await waitForProcessesToExit({
        probe: probe.probe,
        signal: controller.signal,
        onWaiting: waiting.onWaiting,
        now: () => 0,
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 2) {
            controller.abort();
          }
        },
      });
      assert.strictEqual(outcome.status, "cancelled");
      assert.deepStrictEqual(outcome.running, [EDITOR]);
      assert.strictEqual(probe.calls(), 2, "the probe after the aborted sleep never ran");
      assert.strictEqual(waiting.seen[waiting.seen.length - 1], "@0", "the exit tells the UI to close");
    });

    test("already aborted while something is running: cancelled without sleeping", async () => {
      const probe = scriptedProbe([EDITOR]);
      const clock = fakeClock();
      const controller = new AbortController();
      controller.abort();
      const outcome = await waitForProcessesToExit({ probe: probe.probe, signal: controller.signal, now: clock.now, sleep: clock.sleep });
      assert.deepStrictEqual(outcome, { status: "cancelled", waitedMs: 0, running: [EDITOR] });
      assert.deepStrictEqual(clock.sleeps, []);
      assert.strictEqual(probe.calls(), 1);
    });

    test("already aborted but nothing is running: still clear (there is nothing to wait for)", async () => {
      const controller = new AbortController();
      controller.abort();
      const outcome = await waitForProcessesToExit({ probe: scriptedProbe([]).probe, signal: controller.signal });
      assert.strictEqual(outcome.status, "clear");
    });

    test("aborting during the settle: cancelled", async () => {
      const probe = scriptedProbe([EDITOR], [], []);
      const controller = new AbortController();
      let sleeps = 0;
      const outcome = await waitForProcessesToExit({
        probe: probe.probe,
        signal: controller.signal,
        now: () => 0,
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 2) {
            controller.abort(); // the second sleep is the settle
          }
        },
      });
      assert.strictEqual(outcome.status, "cancelled");
      assert.strictEqual(probe.calls(), 2, "no probe after the aborted settle");
    });

    test("the default sleep wakes at once on abort instead of finishing the poll interval", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const started = Date.now();
      const outcome = await waitForProcessesToExit({ probe: scriptedProbe([EDITOR]).probe, pollMs: 60_000, signal: controller.signal });
      assert.strictEqual(outcome.status, "cancelled");
      assert.ok(Date.now() - started < 5_000, "returned long before the 60s poll interval");
    });
  });

  // ---- Wording -------------------------------------------------------------
  suite("describeWait", () => {
    test("names the one process and counts seconds under a minute", () => {
      assert.strictEqual(describeWait([EDITOR], 0), "Waiting for Editor.exe to close... 0s");
      assert.strictEqual(describeWait([EDITOR], 45_900), "Waiting for Editor.exe to close... 45s");
    });

    test("minutes and zero-padded seconds from a minute up", () => {
      assert.strictEqual(describeWait([EDITOR], 60_000), "Waiting for Editor.exe to close... 1m 00s");
      assert.strictEqual(describeWait([EDITOR], 125_000), "Waiting for Editor.exe to close... 2m 05s");
      assert.strictEqual(describeWait([EDITOR], 3_725_000), "Waiting for Editor.exe to close... 62m 05s");
    });

    test("two processes are joined with 'and'", () => {
      assert.strictEqual(
        describeWait([EDITOR, SCRIPT_CANVAS], 5_000),
        "Waiting for Editor.exe and ScriptCanvasApplication.exe to close... 5s",
      );
    });
  });
});
