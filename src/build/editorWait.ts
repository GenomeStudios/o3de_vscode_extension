// ============================================================================
//  Editor wait — block until the Editor (or any guarded process) has closed.
//
//  A running Editor.exe locks the project's gem DLLs, so a build started now
//  fails at the link step. "Build when the Editor closes" waits for it to go
//  away first, then lets the ordinary build run (and its ordinary guard).
//
//  Pure on purpose: the process probe, the clock and the sleep are injected, so
//  the loop is proven with a fake clock and no processes. It knows nothing
//  about VS Code, builds or MCP; the callers wrap it with a notification (the
//  tab) or progress heartbeats (MCP).
// ============================================================================

export interface EditorWaitOptions {
  /** The guarded images running right now (runningGuardedProcesses in production). */
  probe: () => Promise<string[]>;
  /** How often to look while something is running. Default 2s. */
  pollMs?: number;
  /** After the last process disappears, wait this long and look again. Default 1.5s. */
  settleMs?: number;
  /** Give up after this long. Undefined = wait for as long as it takes. */
  maxWaitMs?: number;
  /** Aborting stops the wait early (the Cancel button). */
  signal?: AbortSignal;
  /** Called on every poll with what is still running, and ([], elapsed) when the wait ends, however it ends. */
  onWaiting?: (running: string[], elapsedMs: number) => void;
  /** Resolves after `ms`, or as soon as `signal` aborts. Replaced in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The clock in milliseconds. Replaced in tests. */
  now?: () => number;
}

export interface EditorWaitOutcome {
  /** clear: nothing guarded is running. cancelled: the signal aborted. timeout: still running at maxWaitMs. */
  status: "clear" | "cancelled" | "timeout";
  waitedMs: number;
  /** What was still running when the wait ended (empty when clear). */
  running: string[];
}

const DEFAULT_POLL_MS = 2_000;
// Windows releases a process's DLL handles a beat after it leaves the process list, and the Editor may be relaunched.
const DEFAULT_SETTLE_MS = 1_500;

// ---- The wait ---------------------------------------------------------------
export async function waitForProcessesToExit(options: EditorWaitOptions): Promise<EditorWaitOutcome> {
  const { probe, pollMs = DEFAULT_POLL_MS, settleMs = DEFAULT_SETTLE_MS, maxWaitMs, signal, onWaiting } = options;
  const sleep = options.sleep ?? sleepUnlessAborted;
  const now = options.now ?? Date.now;
  const started = now();

  const finish = (status: EditorWaitOutcome["status"], running: string[]): EditorWaitOutcome => {
    const waitedMs = now() - started;
    onWaiting?.([], waitedMs);
    return { status, waitedMs, running };
  };

  let running = await probe();
  if (running.length === 0) {
    return finish("clear", []); // never had to wait: no settle delay
  }

  for (;;) {
    if (signal?.aborted) {
      return finish("cancelled", running);
    }
    const elapsed = now() - started;
    if (maxWaitMs !== undefined && elapsed >= maxWaitMs) {
      return finish("timeout", running);
    }
    onWaiting?.(running, elapsed);

    // Never sleep past the cap, so a timeout is reported at the cap and not up to a poll later.
    await sleep(maxWaitMs === undefined ? pollMs : Math.min(pollMs, maxWaitMs - elapsed), signal);
    if (signal?.aborted) {
      continue; // the top of the loop reports it
    }

    running = await probe();
    if (running.length > 0) {
      continue;
    }

    // Looks clear. Give Windows a moment to let go of the DLLs, then confirm nothing was relaunched.
    await sleep(settleMs, signal);
    if (signal?.aborted) {
      continue;
    }
    running = await probe();
    if (running.length === 0) {
      return finish("clear", []);
    }
  }
}

// ---- Wording ----------------------------------------------------------------
/** "Waiting for Editor.exe to close... 2m 05s" */
export function describeWait(running: string[], elapsedMs: number): string {
  const what = running.join(" and ") || "the Editor";
  return `Waiting for ${what} to close... ${formatElapsed(elapsedMs)}`;
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${Math.floor(totalSeconds / 60)}m ${seconds}s`;
}

// ---- Default sleep ----------------------------------------------------------
/** A timer that resolves early when the signal aborts, so Cancel is not held up by the poll interval. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    if (signal?.aborted) {
      wake();
      return;
    }
    signal?.addEventListener("abort", wake, { once: true });
  });
}
