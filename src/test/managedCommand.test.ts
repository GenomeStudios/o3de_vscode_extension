// ============================================================================
//  Managed commands — the job's conclusion is printed into its output channel
//  BEFORE the job reports done (#29): the last unterminated line, any spawn
//  error, then one "=== <label> succeeded / FAILED ===" line. Real processes
//  (this Node binary), a collector in place of the channel.
// ============================================================================

import * as assert from "assert";
import { runManagedCommand } from "../build/managedCommand";

function collector(): { lines: string[]; appendLine: (line: string) => void } {
  const lines: string[] = [];
  return { lines, appendLine: (line: string) => lines.push(line) };
}

let jobCounter = 0;
const key = (): string => `test:managedCommand:${jobCounter++}`;

suite("managedCommand conclusion", () => {
  test("a failing process: its last line (no trailing newline) prints, then the FAILED outcome, before done resolves", async () => {
    const output = collector();
    const result = await runManagedCommand({
      key: key(),
      kind: "build",
      label: "Build Demo",
      argv: [process.execPath, "-e", "process.stdout.write('first\\nlast words'); process.exit(3)"],
      cwd: process.cwd(),
      output,
    });
    assert.strictEqual(result.exitCode, 3);
    const outcome = output.lines[output.lines.length - 1];
    assert.match(outcome, /^=== Build Demo FAILED \(exit 3\) in [\d.]+s ===$/);
    assert.ok(output.lines.indexOf("last words") !== -1, output.lines.join(" | "));
    assert.ok(output.lines.indexOf("last words") < output.lines.length - 1, "output precedes the outcome line");
  });

  test("a successful process ends with a succeeded outcome", async () => {
    const output = collector();
    await runManagedCommand({
      key: key(),
      kind: "configure",
      label: "Configure Demo",
      argv: [process.execPath, "-e", "console.log('ok')"],
      cwd: process.cwd(),
      output,
    });
    assert.match(output.lines[output.lines.length - 1], /^=== Configure Demo succeeded in [\d.]+s ===$/);
  });

  test("a process that can't start prints the spawn error into the channel, then the outcome", async () => {
    const output = collector();
    const result = await runManagedCommand({
      key: key(),
      kind: "build",
      label: "Build Missing",
      argv: ["o3de-no-such-executable-for-tests"],
      cwd: process.cwd(),
      output,
    });
    assert.strictEqual(result.exitCode, null);
    assert.ok(output.lines.some((line) => line.includes("[spawn error]")), output.lines.join(" | "));
    assert.match(output.lines[output.lines.length - 1], /^=== Build Missing FAILED \(exit \?\) in [\d.]+s ===$/);
  });
});
