// ============================================================================
//  MCP o3de_intellisense_health - end to end through the real MCP SDK client,
//  and the command that shares its core.
//
//  The test host has no workspace folder, so there is no project to check: the tool
//  must refuse clearly and at once (and never hang a client waiting for progress).
//  What a check does with a real database is proven in healthRun.test.ts.
// ============================================================================

import * as assert from "assert";
import * as vscode from "vscode";
import { EXTENSION_ID } from "../constants";
import type { HealthOutcome } from "../intellisense/healthModel";
import { McpHarness, payload, startMcpHarness, summaryLine } from "./mcpHarness";

suite("MCP IntelliSense health tool (end to end)", () => {
  let mcp: McpHarness | undefined;

  suiteSetup(async () => {
    mcp = await startMcpHarness();
  });

  suiteTeardown(async () => {
    await mcp?.close();
  });

  const tool = async () => (await mcp!.client.listTools()).tools.find((candidate) => candidate.name === "o3de_intellisense_health");

  const refused = async (args: Record<string, unknown>): Promise<boolean> => {
    try {
      const result = await mcp!.client.callTool({ name: "o3de_intellisense_health", arguments: args });
      return result.isError === true;
    } catch {
      return true; // rejected as a protocol error: also a refusal
    }
  };

  // ---- Listed, read-only, described -----------------------------------------
  test("the tool is listed and read-only (it only runs clangd --check)", async () => {
    const found = await tool();
    assert.ok(found, "o3de_intellisense_health is listed");
    assert.strictEqual(found?.annotations?.readOnlyHint, true);
    assert.strictEqual(found?.annotations?.openWorldHint, false);
  });

  test("sampleSize is an optional integer 1..20 and includeEntryless an optional boolean", async () => {
    const schema = (await tool())?.inputSchema as
      | { properties?: Record<string, { type?: string; minimum?: number; maximum?: number }>; required?: string[] }
      | undefined;
    assert.strictEqual(schema?.properties?.sampleSize?.type, "integer");
    assert.strictEqual(schema?.properties?.sampleSize?.minimum, 1);
    assert.strictEqual(schema?.properties?.sampleSize?.maximum, 20);
    assert.strictEqual(schema?.properties?.includeEntryless?.type, "boolean");
    assert.deepStrictEqual(schema?.required ?? [], [], "nothing is required");
  });

  test("the description says what it reports and how to read it", async () => {
    const description = (await tool())?.description ?? "";
    for (const word of [
      "clangd --check",
      "report.findings",
      "report.summary",
      "report.clangd",
      "report.toolchain",
      "report.database",
      "report.engine",
      "report.files",
      "noEntry",
      "inferredFrom",
      "headersOnly",
      "builds no index and writes nothing",
      "progress",
      "noProject",
    ]) {
      assert.ok(description.includes(word), `${word} in the description`);
    }
  });

  // ---- No project: a clear refusal, quickly ---------------------------------
  test("with no O3DE project open it refuses, says why, and returns at once", async () => {
    const started = Date.now();
    const result = await mcp!.client.callTool({ name: "o3de_intellisense_health", arguments: {} });
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
    assert.strictEqual(result.isError, true);
    assert.match(summaryLine(result), /No O3DE project is open in this workspace/);
    const outcome = payload<HealthOutcome>(result);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(!outcome.ok && outcome.reason, "noProject");
    assert.ok(!outcome.ok && outcome.message.length > 0);
  });

  test("the refusal is the same with every argument given", async () => {
    const result = await mcp!.client.callTool({ name: "o3de_intellisense_health", arguments: { sampleSize: 3, includeEntryless: false } });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(payload<HealthOutcome>(result).ok, false);
  });

  // Heartbeats and the time budget are proven in mcpProgress.test.ts, against a fake check.
  test("a client that asks for progress is not left waiting on a refusal", async () => {
    const started = Date.now();
    const result = await mcp!.client.callTool({ name: "o3de_intellisense_health", arguments: {} }, undefined, {
      onprogress: () => undefined,
    });
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
    assert.strictEqual(result.isError, true);
    assert.match(summaryLine(result), /No O3DE project is open in this workspace/);
  });

  // ---- Bad arguments --------------------------------------------------------
  test("a sampleSize outside 1..20 or not a whole number is rejected", async () => {
    for (const sampleSize of [0, 21, 2.5, "six"]) {
      assert.ok(await refused({ sampleSize }), `sampleSize ${String(sampleSize)}`);
    }
  });

  test("an includeEntryless that isn't a boolean is rejected", async () => {
    assert.ok(await refused({ includeEntryless: "yes" }));
  });

  // ---- The command ----------------------------------------------------------
  test("the command O3DE: Check IntelliSense Health is contributed and registered", async () => {
    const contributed = (vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as { contributes?: { commands?: { command: string; title: string }[] } } | undefined)
      ?.contributes?.commands;
    assert.strictEqual(contributed?.find((command) => command.command === "o3de.checkIntelliSenseHealth")?.title, "O3DE: Check IntelliSense Health");
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const registered = await vscode.commands.getCommands(true);
    assert.ok(registered.includes("o3de.checkIntelliSenseHealth"), "registered at activation");
  });
});
