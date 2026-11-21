// ============================================================================
//  Launch-args history (issue #39) — the pure list rules, and how BuildOptions
//  records into them when the launch args change. The picker itself is a thin
//  UI wrapper over these and is not unit-testable in the test host.
// ============================================================================

import * as assert from "assert";
import type * as vscode from "vscode";
import { BuildOptions } from "../build/buildOptions";
import {
  LAUNCH_ARGS_HISTORY_MAX,
  pushLaunchArgsHistory,
  removeLaunchArgsHistory,
  sanitizeLaunchArgsHistory,
} from "../build/launchArgsHistory";

// ---- Helpers -----------------------------------------------------------------
/** A minimal in-memory Memento, optionally pre-filled (workspaceState stand-in). */
function stubMemento(initial: Record<string, unknown> = {}): vscode.Memento {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    keys: () => [...values.keys()],
    get: (key: string, defaultValue?: unknown) => (values.has(key) ? values.get(key) : defaultValue),
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
}

// ---- The list rules ----------------------------------------------------------
suite("Launch-args history rules", () => {
  test("a pushed value goes first and is trimmed", () => {
    assert.deepStrictEqual(pushLaunchArgsHistory(["+a 1"], "  +b 2 "), ["+b 2", "+a 1"]);
  });

  test("pushing a listed value moves it to the front without duplicating it", () => {
    assert.deepStrictEqual(pushLaunchArgsHistory(["+b 2", "+a 1", "+c 3"], "+c 3"), ["+c 3", "+b 2", "+a 1"]);
  });

  test("a blank value changes nothing", () => {
    assert.deepStrictEqual(pushLaunchArgsHistory(["+a 1"], ""), ["+a 1"]);
    assert.deepStrictEqual(pushLaunchArgsHistory(["+a 1"], "   "), ["+a 1"]);
  });

  test("the history is capped, dropping the oldest", () => {
    let history: string[] = [];
    for (let i = 1; i <= LAUNCH_ARGS_HISTORY_MAX + 2; i++) {
      history = pushLaunchArgsHistory(history, `+n ${i}`);
    }
    assert.strictEqual(history.length, LAUNCH_ARGS_HISTORY_MAX);
    assert.strictEqual(history[0], `+n ${LAUNCH_ARGS_HISTORY_MAX + 2}`, "newest first");
    assert.strictEqual(history[history.length - 1], "+n 3", "the two oldest fell off");
    assert.deepStrictEqual(pushLaunchArgsHistory(["a", "b", "c"], "d", 2), ["d", "a"], "a custom cap is honored");
  });

  test("entries differing only by case or quoting stay separate", () => {
    const quoted = '+LoadLevel "My Level"';
    const unquoted = "+LoadLevel My Level";
    assert.deepStrictEqual(pushLaunchArgsHistory([quoted], unquoted), [unquoted, quoted]);
    assert.deepStrictEqual(pushLaunchArgsHistory(["+A"], "+a"), ["+a", "+A"]);
  });

  test("the input list is never mutated", () => {
    const history = ["+a 1", "+b 2"];
    pushLaunchArgsHistory(history, "+b 2");
    pushLaunchArgsHistory(history, "+c 3");
    pushLaunchArgsHistory(history, "");
    removeLaunchArgsHistory(history, "+a 1");
    assert.deepStrictEqual(history, ["+a 1", "+b 2"]);
  });

  test("remove deletes the exact entry and is a no-op when it is absent", () => {
    assert.deepStrictEqual(removeLaunchArgsHistory(["+a 1", "+b 2"], "+a 1"), ["+b 2"]);
    assert.deepStrictEqual(removeLaunchArgsHistory(["+a 1", "+b 2"], "+z"), ["+a 1", "+b 2"]);
    assert.deepStrictEqual(removeLaunchArgsHistory(["+a 1", "+b 2"], " +b 2 "), ["+a 1"], "the value is trimmed");
  });

  test("sanitize turns anything stored into a clean, capped list", () => {
    assert.deepStrictEqual(sanitizeLaunchArgsHistory(undefined), []);
    assert.deepStrictEqual(sanitizeLaunchArgsHistory("+a 1"), [], "not an array");
    assert.deepStrictEqual(sanitizeLaunchArgsHistory([" +a 1 ", 5, null, "", "  ", "+b 2", "+a 1"]), ["+a 1", "+b 2"]);
    const many = Array.from({ length: LAUNCH_ARGS_HISTORY_MAX + 5 }, (_, i) => `+n ${i}`);
    assert.strictEqual(sanitizeLaunchArgsHistory(many).length, LAUNCH_ARGS_HISTORY_MAX);
  });
});

// ---- How BuildOptions records ------------------------------------------------
suite("Launch-args history in BuildOptions", () => {
  let options: BuildOptions;

  setup(() => {
    options = new BuildOptions(stubMemento());
  });

  teardown(() => {
    options.dispose();
  });

  test("a fresh workspace has no history", () => {
    assert.deepStrictEqual(options.launchArgsHistory, []);
    assert.strictEqual(options.launchArgs, "");
  });

  test("each new value is recorded first, and switching back moves it to the front", async () => {
    await options.setLaunchArgs("A");
    assert.deepStrictEqual(options.launchArgsHistory, ["A"]);
    await options.setLaunchArgs("B");
    assert.deepStrictEqual(options.launchArgsHistory, ["B", "A"]);
    assert.strictEqual(options.launchArgs, "B");
    await options.setLaunchArgs("A");
    assert.deepStrictEqual(options.launchArgsHistory, ["A", "B"]);
    assert.strictEqual(options.launchArgs, "A");
  });

  test("the value is trimmed before it is stored", async () => {
    await options.setLaunchArgs("  +a 1  ");
    assert.strictEqual(options.launchArgs, "+a 1");
    assert.deepStrictEqual(options.launchArgsHistory, ["+a 1"]);
  });

  test("clearing the args keeps the old value in the history", async () => {
    await options.setLaunchArgs("A");
    await options.setLaunchArgs("B");
    await options.setLaunchArgs("");
    assert.strictEqual(options.launchArgs, "");
    assert.deepStrictEqual(options.launchArgsHistory, ["B", "A"]);
  });

  test("launch args set before the history existed are kept the first time they change", async () => {
    const legacy = new BuildOptions(stubMemento({ "o3de.run.launchArgs": "X" }));
    try {
      assert.deepStrictEqual(legacy.launchArgsHistory, []);
      await legacy.setLaunchArgs("Y");
      assert.deepStrictEqual(legacy.launchArgsHistory, ["Y", "X"]);
    } finally {
      legacy.dispose();
    }
  });

  test("an entry removed from the history is not brought back by the next change", async () => {
    await options.setLaunchArgs("+b");
    await options.setLaunchArgs("+a");
    await options.setLaunchArgsHistory(["+b"]); // "+a", the current args, is removed from the list
    await options.setLaunchArgs("+b");
    assert.deepStrictEqual(options.launchArgsHistory, ["+b"], "the old current value stays out");
  });

  test("a cleared history stays cleared: the next change records only the new value", async () => {
    await options.setLaunchArgs("A");
    await options.setLaunchArgsHistory([]);
    await options.setLaunchArgs("B");
    assert.deepStrictEqual(options.launchArgsHistory, ["B"]);
  });

  test("setLaunchArgsHistory replaces the list, cleaned and capped, and clears with []", async () => {
    await options.setLaunchArgs("A");
    await options.setLaunchArgsHistory(["B", " B ", "", "C"]);
    assert.deepStrictEqual(options.launchArgsHistory, ["B", "C"]);
    assert.strictEqual(options.launchArgs, "A", "the current args are not touched");
    await options.setLaunchArgsHistory([]);
    assert.deepStrictEqual(options.launchArgsHistory, []);
  });

  test("a corrupt stored history reads back as empty", () => {
    const broken = new BuildOptions(stubMemento({ "o3de.run.launchArgsHistory": { not: "a list" } }));
    try {
      assert.deepStrictEqual(broken.launchArgsHistory, []);
    } finally {
      broken.dispose();
    }
  });

  test("onDidChange fires once per change", async () => {
    let fired = 0;
    const listener = options.onDidChange(() => fired++);
    try {
      await options.setLaunchArgs("A");
      assert.strictEqual(fired, 1);
      await options.setLaunchArgsHistory([]);
      assert.strictEqual(fired, 2);
    } finally {
      listener.dispose();
    }
  });
});
