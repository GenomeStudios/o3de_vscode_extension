// ============================================================================
//  MCP run tools (issues #44, #43) -- o3de_run_debug, o3de_run's settleSeconds
//  and o3de_read_run_log, end to end through the real MCP SDK client. The test
//  host has no workspace folder and no C/C++ extension, so the only refusals
//  reachable here are the early ones (platform, project); the later ones
//  (no-debugger, not-built, already-running, start-failed, a real Editor
//  launch) need a built project and a debugger, and are checked by hand.
//  The log reading is unit-tested in runLog.test.ts, and the settle report
//  (monitorLaunch) in runMonitor.test.ts.
// ============================================================================

import * as assert from "assert";
import type { DebugLaunchResult, LaunchResult, RunLogReport } from "../build/runQuery";
import { McpHarness, payload, startMcpHarness, summaryLine } from "./mcpHarness";

suite("MCP run tools (end to end)", () => {
  let mcp: McpHarness | undefined;

  suiteSetup(async () => {
    mcp = await startMcpHarness();
  });

  suiteTeardown(async () => {
    await mcp?.close();
  });

  test("o3de_run_debug is listed with an optional target and config", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((t) => t.name === "o3de_run_debug");
    assert.ok(tool, "o3de_run_debug missing");
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
    assert.ok("target" in properties, "target missing from the schema");
    assert.deepStrictEqual(properties.config?.enum, ["profile", "debug", "release"]);
    assert.strictEqual(tool.inputSchema.required, undefined, "both inputs are optional");
    assert.strictEqual(tool.annotations?.readOnlyHint, false);
    assert.strictEqual(tool.annotations?.destructiveHint, false);
  });

  test("o3de_run_debug refuses without a project, quickly, and says why", async () => {
    const started = Date.now();
    const result = await mcp!.client.callTool({ name: "o3de_run_debug", arguments: { config: "profile" } });
    assert.ok(Date.now() - started < 5_000, "a refusal must not wait on anything");

    assert.strictEqual(result.isError, true);
    const debug = payload<DebugLaunchResult>(result);
    assert.strictEqual(debug.started, false);
    // no-project on a supported OS; platform-unsupported anywhere the platform tools are off.
    assert.ok(
      debug.blocked === "no-project" || debug.blocked === "platform-unsupported",
      `unexpected blocked: ${debug.blocked}`,
    );
    assert.ok(debug.reason && debug.reason.length > 0, "a refusal always carries a reason");
    assert.strictEqual(debug.config, "profile", "the override is echoed back");
    assert.strictEqual(debug.session, undefined, "no session was started");
    assert.match(summaryLine(result), /Did not start/);
  });

  test("o3de_run offers an optional settleSeconds of 0..30", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((t) => t.name === "o3de_run");
    assert.ok(tool, "o3de_run missing");
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string; minimum?: number; maximum?: number }>;
    assert.strictEqual(properties.settleSeconds?.type, "integer");
    assert.strictEqual(properties.settleSeconds?.minimum, 0);
    assert.strictEqual(properties.settleSeconds?.maximum, 30);
    assert.strictEqual(tool.inputSchema.required, undefined, "every input is optional");
  });

  test("o3de_run with settleSeconds refuses without a project, quickly: the settle never holds a refusal", async () => {
    const started = Date.now();
    const result = await mcp!.client.callTool({ name: "o3de_run", arguments: { settleSeconds: 5 } });
    assert.ok(Date.now() - started < 3_000, "a refused launch must not wait out the 5 s settle");

    assert.strictEqual(result.isError, true);
    const launch = payload<LaunchResult & { monitor?: unknown }>(result);
    assert.strictEqual(launch.launched, false);
    assert.ok(launch.reason && launch.reason.length > 0, "a refusal always carries a reason");
    assert.strictEqual(launch.monitor, undefined, "nothing launched, so nothing to monitor");
    assert.match(summaryLine(result), /Did not launch/);
  });

  test("o3de_read_run_log is listed, read-only, with optional log and tailLines", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((t) => t.name === "o3de_read_run_log");
    assert.ok(tool, "o3de_read_run_log missing");
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[]; maximum?: number; minimum?: number }>;
    assert.deepStrictEqual(properties.log?.enum, ["auto", "editor", "game", "error"]);
    assert.strictEqual(properties.tailLines?.minimum, 1);
    assert.strictEqual(properties.tailLines?.maximum, 500);
    assert.strictEqual(tool.inputSchema.required, undefined, "both inputs are optional");
    assert.strictEqual(tool.annotations?.readOnlyHint, true);
    assert.strictEqual(tool.annotations?.openWorldHint, false);
  });

  test("o3de_read_run_log says so when there is no project, and returns no log", async () => {
    const result = await mcp!.client.callTool({ name: "o3de_read_run_log", arguments: { log: "error", tailLines: 20 } });
    assert.notStrictEqual(result.isError, true);
    assert.match(summaryLine(result), /No O3DE project/);
    const report = payload<RunLogReport>(result);
    assert.match(report.note ?? "", /No O3DE project/);
    assert.strictEqual(report.log, undefined);
    assert.strictEqual(report.project, undefined);
  });
});
