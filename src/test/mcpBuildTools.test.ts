// ============================================================================
//  MCP build-pipeline tools (issue #25) — end to end through the real MCP SDK
//  client: o3de_configure / o3de_configure_status / o3de_stop, and the CMake
//  flags + core count + launch-args history (#39) in o3de_get_config /
//  o3de_set_config, plus o3de_build's waitForEditorExit option (#33). The test
//  host has no workspace, so every project-bound action must refuse cleanly and
//  say why (the wait itself needs a real project and Editor: checked by hand).
// ============================================================================

import * as assert from "assert";
import type { BuildResult } from "../build/buildOutput";
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

  test("o3de_build offers waitForEditorExit and maxWaitMinutes (1 to 60)", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((t) => t.name === "o3de_build");
    const properties = (tool?.inputSchema.properties ?? {}) as Record<string, { type?: string; minimum?: number; maximum?: number }>;
    assert.strictEqual(properties.waitForEditorExit?.type, "boolean");
    assert.strictEqual(properties.maxWaitMinutes?.type, "integer");
    assert.strictEqual(properties.maxWaitMinutes?.minimum, 1);
    assert.strictEqual(properties.maxWaitMinutes?.maximum, 60);
  });

  test("o3de_build waitForEditorExit without a project returns promptly with the usual refusal", async () => {
    const started = Date.now();
    const result = await mcp!.client.callTool({ name: "o3de_build", arguments: { waitForEditorExit: true, maxWaitMinutes: 1 } });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(payload<BuildResult>(result).blocked, "no-project");
    assert.ok(Date.now() - started < 15_000, "it did not wait for anything");
  });

  test("o3de_build rejects a maxWaitMinutes outside 1 to 60", async () => {
    for (const maxWaitMinutes of [0, 61]) {
      // The SDK reports a schema violation as an error result or as a rejected call, depending on its version.
      const refused = await mcp!.client
        .callTool({ name: "o3de_build", arguments: { waitForEditorExit: true, maxWaitMinutes } })
        .then((result) => result.isError === true, () => true);
      assert.ok(refused, `maxWaitMinutes ${maxWaitMinutes} should be refused`);
    }
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

  test("o3de_get_config reports an empty launch-args history by default", async () => {
    const snapshot = payload<ConfigSnapshot>(await mcp!.client.callTool({ name: "o3de_get_config", arguments: {} }));
    assert.deepStrictEqual(snapshot.launchArgsHistory, []);
  });

  test("o3de_set_config launchArgs is recorded into the history, most recent first", async () => {
    await mcp!.client.callTool({ name: "o3de_set_config", arguments: { launchArgs: "+a 1" } });
    const result = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { launchArgs: " +b 2 " } });
    assert.notStrictEqual(result.isError, true);
    const snapshot = payload<ConfigSnapshot>(result);
    assert.strictEqual(snapshot.launchArgs, "+b 2", "stored trimmed, like the panel does");
    assert.deepStrictEqual(snapshot.launchArgsHistory, ["+b 2", "+a 1"]);
    assert.deepStrictEqual(mcp!.buildOptions.launchArgsHistory, ["+b 2", "+a 1"], "the same state the panel reads");
  });

  test("o3de_set_config launchArgsHistory replaces the list, and [] clears it", async () => {
    const replaced = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { launchArgsHistory: ["+a 1"] } });
    assert.match(summaryLine(replaced), /launchArgsHistory/);
    const snapshot = payload<ConfigSnapshot>(replaced);
    assert.deepStrictEqual(snapshot.launchArgsHistory, ["+a 1"]);
    assert.strictEqual(snapshot.launchArgs, "+b 2", "the current args are left alone");

    const cleared = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { launchArgsHistory: [] } });
    assert.deepStrictEqual(payload<ConfigSnapshot>(cleared).launchArgsHistory, []);
    assert.deepStrictEqual(mcp!.buildOptions.launchArgsHistory, []);
  });

  test("o3de_set_config with launchArgs and launchArgsHistory together ends with the given history", async () => {
    const result = await mcp!.client.callTool({
      name: "o3de_set_config",
      arguments: { launchArgs: "+c 3", launchArgsHistory: ["+x", "+y"] },
    });
    const snapshot = payload<ConfigSnapshot>(result);
    assert.strictEqual(snapshot.launchArgs, "+c 3");
    assert.deepStrictEqual(snapshot.launchArgsHistory, ["+x", "+y"]);
  });

  test("o3de_set_config launchArgs after a cleared history records only the new value", async () => {
    await mcp!.client.callTool({ name: "o3de_set_config", arguments: { launchArgsHistory: [] } });
    const result = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { launchArgs: "+d 4" } });
    assert.deepStrictEqual(payload<ConfigSnapshot>(result).launchArgsHistory, ["+d 4"], "the previous current value does not come back");
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

  test("o3de_set_config refuses a patch whose CMake flags are invalid without changing its other fields", async () => {
    const before = mcp!.buildOptions.config;
    const config = before === "debug" ? "release" : "debug";
    const result = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { config, cmakeFlags: { "NOT A NAME": "ON" } } });
    assert.strictEqual(result.isError, true);
    assert.match(summaryLine(result), /Not changed/);
    assert.strictEqual(mcp!.buildOptions.config, before, "a refused patch changes nothing");
  });

  test("o3de_set_config refuses a patch with CMake flags but no project without changing its other fields", async () => {
    const before = mcp!.buildOptions.config;
    const config = before === "debug" ? "release" : "debug";
    const result = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { config, cmakeFlags: { LY_RENDERDOC_ENABLED: "ON" } } });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(mcp!.buildOptions.config, before, "a refused patch changes nothing");
  });
});
