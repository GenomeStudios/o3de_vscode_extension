// ============================================================================
//  MCP build-pipeline tools (issue #25) — end to end through the real MCP SDK
//  client: o3de_configure / o3de_configure_status / o3de_stop, and the CMake
//  flags + core count in o3de_get_config / o3de_set_config. The test host has no
//  workspace, so every project-bound action must refuse cleanly and say why.
// ============================================================================

import * as assert from "assert";
import type { ConfigureResult } from "../build/configure";
import type { ConfigSnapshot } from "../build/configQuery";
import { McpHarness, payload, startMcpHarness, summaryLine } from "./mcpHarness";

suite("MCP build-pipeline tools (end to end)", () => {
  let mcp: McpHarness | undefined;

  suiteSetup(async () => {
    mcp = await startMcpHarness();
  });

  suiteTeardown(async () => {
    await mcp?.close();
  });

  test("configure, configure status and stop are listed", async () => {
    const names = (await mcp!.client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["o3de_configure", "o3de_configure_status", "o3de_stop"]) {
      assert.ok(names.includes(name), `${name} missing from ${names.join(", ")}`);
    }
  });

  test("o3de_configure without a project refuses as blocked:no-project, and the status tool returns that result", async () => {
    const result = await mcp!.client.callTool({ name: "o3de_configure", arguments: {} });
    assert.strictEqual(result.isError, true);
    const configure = payload<ConfigureResult>(result);
    assert.strictEqual(configure.blocked, "no-project");
    assert.strictEqual(configure.ok, false);
    assert.strictEqual(configure.command, "", "never started");

    const status = await mcp!.client.callTool({ name: "o3de_configure_status", arguments: {} });
    assert.strictEqual(payload<ConfigureResult>(status).blocked, "no-project");
  });

  test("o3de_stop without a project is an error that says so", async () => {
    const result = await mcp!.client.callTool({ name: "o3de_stop", arguments: { job: "build" } });
    assert.strictEqual(result.isError, true);
    assert.match(summaryLine(result), /No O3DE project/);
  });

  test("o3de_get_config reports the core count; CMake flags need a project", async () => {
    const snapshot = payload<ConfigSnapshot>(await mcp!.client.callTool({ name: "o3de_get_config", arguments: {} }));
    assert.strictEqual(snapshot.coreCount, 0, "auto by default");
    assert.strictEqual(snapshot.cmakeFlags, undefined, "no project → no flags report");
  });

  test("o3de_set_config changes the core count", async () => {
    const result = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { coreCount: 6 } });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(payload<ConfigSnapshot>(result).coreCount, 6);
    assert.strictEqual(mcp!.buildOptions.coreCount, 6, "the same state the panel reads");
  });

  test("o3de_set_config rejects invalid CMake variable names before writing anything", async () => {
    const result = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { cmakeFlags: { "NOT A NAME": "ON" } } });
    assert.strictEqual(result.isError, true);
    assert.match(summaryLine(result), /Not valid CMake variable names: NOT A NAME/);
  });

  test("o3de_set_config with CMake flags but no project refuses instead of writing workspace settings", async () => {
    const result = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { cmakeFlags: { LY_RENDERDOC_ENABLED: "ON" } } });
    assert.strictEqual(result.isError, true);
    assert.match(summaryLine(result), /stored per project/);
  });
});
