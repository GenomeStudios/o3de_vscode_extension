// ============================================================================
//  "Add LLVM to PATH" — the PowerShell script, executed for real with its user
//  PATH read and write swapped out, so running the suite never touches PATH.
//
//  REGRESSION GUARD: the script is assembled from lines joined with "; ". Putting
//  that separator between `if {…}` and `else {…}` made PowerShell run `else` as a
//  command — the action failed every time. Only executing the script catches that.
// ============================================================================

import * as assert from "assert";
import { execFileSync } from "child_process";
import { ADD_TO_USER_PATH_SCRIPT } from "../deps/actions";

const READ = "[Environment]::GetEnvironmentVariable('Path', 'User')";
const WRITE = "[Environment]::SetEnvironmentVariable('Path', $updated, 'User')";

/** Run the shipped script against a fake user PATH; returns [would-write, outcome]. */
function dryRun(currentUserPath: string, dir: string): string[] {
  const script = ADD_TO_USER_PATH_SCRIPT.replace(READ, "$env:O3DE_TEST_USER_PATH").replace(
    WRITE,
    "Write-Output ('WOULD WRITE: ' + $updated)",
  );
  assert.ok(!script.includes("SetEnvironmentVariable"), "the real write must be gone before anything runs");
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, O3DE_TEST_USER_PATH: currentUserPath, O3DE_ADD_TO_PATH: dir },
    windowsHide: true,
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/);
}

suite("actions: add to user PATH (PowerShell, dry run)", function () {
  if (process.platform !== "win32") {
    return; // PowerShell + user PATH are the Windows path; elsewhere the action only shows a message
  }
  this.timeout(20000);
  const LLVM = "C:\\Program Files\\LLVM\\bin";

  test("the script's read/write calls are the shapes this guard swaps out", () => {
    assert.ok(ADD_TO_USER_PATH_SCRIPT.includes(READ) && ADD_TO_USER_PATH_SCRIPT.includes(WRITE));
  });

  test("parses and appends the folder", () => {
    assert.deepStrictEqual(dryRun("C:\\a;C:\\b", LLVM), [`WOULD WRITE: C:\\a;C:\\b;${LLVM}`, "added"]);
  });

  test("already present (any case, trailing backslash) → writes nothing", () => {
    assert.deepStrictEqual(dryRun("C:\\a;c:\\program files\\llvm\\bin\\", LLVM), ["present"]);
  });

  test("a quote in the folder is data, not script", () => {
    assert.deepStrictEqual(dryRun("C:\\a", "C:\\it's here"), ["WOULD WRITE: C:\\a;C:\\it's here", "added"]);
  });
});
