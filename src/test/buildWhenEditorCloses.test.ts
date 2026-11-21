// ============================================================================
//  Build When Editor Closes (#33) -- the command refuses to join a build that is
//  already running. The Build button turns into Stop while a build runs, so the
//  command would otherwise join that build and report its result a second time
//  (for a build it did not start, when MCP started it). Checked twice: before
//  the wait, and after it (a build can start while the command waits, e.g. the
//  Build button's "Close & Build").
//
//  A real long-running process stands in for the build (registered as a "build"
//  job), the Editor probe is scripted, and the test host has no workspace: if the
//  command went on to build, "No O3DE project in this workspace" would be shown.
// ============================================================================

import * as assert from "assert";
import * as vscode from "vscode";
import { buildWhenEditorCloses } from "../build/build";
import { BuildOptions } from "../build/buildOptions";
import { cancelManagedCommand, ManagedJob, startManagedCommand } from "../build/managedCommand";
import { memoryMemento } from "./mcpHarness";

const JOB_KEY = "test:buildWhenEditorCloses";

// ---- Fakes -----------------------------------------------------------------
/** A "build" job that stays running until it is stopped. */
function startFakeBuild(): ManagedJob {
  return startManagedCommand({
    key: JOB_KEY,
    kind: "build",
    label: "Build Demo",
    argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
    cwd: process.cwd(),
    echo: false,
  });
}

/** Replace the message functions with recorders; an unanswered toast never resolves. */
function recordToasts(): { messages: string[]; restore(): void } {
  const windowApi = vscode.window as unknown as Record<string, unknown>;
  const names = ["showErrorMessage", "showWarningMessage", "showInformationMessage"];
  const originals = names.map((name) => windowApi[name]);
  const messages: string[] = [];
  names.forEach((name) => {
    windowApi[name] = (message: string) => {
      messages.push(message);
      return new Promise<never>(() => undefined);
    };
  });
  return { messages, restore: () => names.forEach((name, i) => (windowApi[name] = originals[i])) };
}

// ---- The tests ---------------------------------------------------------------
suite("buildWhenEditorCloses (a build is already running)", () => {
  let toasts: ReturnType<typeof recordToasts>;
  let started: ManagedJob | undefined;

  setup(() => {
    toasts = recordToasts();
    started = undefined;
  });

  teardown(async () => {
    toasts.restore();
    if (await cancelManagedCommand(JOB_KEY)) {
      await started?.done;
    }
  });

  test("before the wait: says a build is running, and neither waits nor builds", async () => {
    started = startFakeBuild();
    let looks = 0;
    await buildWhenEditorCloses(new BuildOptions(memoryMemento()), async () => {
      looks += 1;
      return [];
    });
    assert.strictEqual(looks, 0, "it did not even look for the Editor");
    assert.deepStrictEqual(toasts.messages, ["O3DE: a build is already running — use Stop Build to cancel it."]);
  });

  test("after the wait: a build that started while it waited is not joined and reported twice", async function () {
    this.timeout(20_000);
    let looks = 0;
    const probe = async (): Promise<string[]> => {
      looks += 1;
      if (looks === 3) {
        started = startFakeBuild(); // the Editor closed, and a build started in the same moment
      }
      return looks <= 2 ? ["Editor.exe"] : [];
    };
    await buildWhenEditorCloses(new BuildOptions(memoryMemento()), probe);
    assert.ok(looks >= 3, "it waited for the Editor");
    assert.deepStrictEqual(toasts.messages, ["O3DE: a build is already running — use Stop Build to cancel it."]);
  });

  test("with no build running it goes on to build (here: no workspace, so the usual refusal)", async () => {
    await buildWhenEditorCloses(new BuildOptions(memoryMemento()), async () => []);
    assert.strictEqual(toasts.messages.length, 1, toasts.messages.join(" | "));
    assert.doesNotMatch(toasts.messages[0], /already running/);
  });
});
