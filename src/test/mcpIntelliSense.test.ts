// ============================================================================
//  MCP IntelliSense tools — end to end through the real MCP SDK client.
//
//  Starts the extension's localhost MCP server on a free port, connects the way
//  Claude Code does (Streamable HTTP), and calls the IntelliSense tools. The test
//  host has no workspace and neither the C/C++ extension nor clangd installed,
//  so the switch must refuse — and write nothing.
// ============================================================================

import * as assert from "assert";
import * as vscode from "vscode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BuildOptions } from "../build/buildOptions";
import { McpHttpHandle, startMcpHttpServer } from "../mcp/serverImpl";
import type { IntelliSenseReport } from "../intellisense/intellisenseQuery";
import type { EngineSwitchResult } from "../intellisense/clangdMode";
import type { SyncOutcome } from "../intellisense/clangdSync";

type TextContent = { type: string; text: string };

function memoryMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: (key: string, defaultValue?: unknown) => (values.has(key) ? values.get(key) : defaultValue),
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
}

/** The tool's JSON payload — every O3DE tool returns a summary line, then the JSON. */
function payload<T>(result: unknown): T {
  const content = (result as { content: TextContent[] }).content;
  return JSON.parse(content[1].text) as T;
}

suite("MCP IntelliSense tools (end to end)", () => {
  const state = memoryMemento();
  let handle: McpHttpHandle | undefined;
  let client: Client | undefined;

  suiteSetup(async () => {
    handle = await startMcpHttpServer({
      port: 0, // any free port
      token: "test",
      requireToken: false,
      allowForceClose: false,
      version: "test",
      buildOptions: new BuildOptions(state),
      workspaceState: state,
    });
    client = new Client({ name: "o3de-tests", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)));
  });

  suiteTeardown(async () => {
    await client?.close();
    await handle?.close();
  });

  test("the IntelliSense tools are listed", async () => {
    const names = (await client!.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("o3de_intellisense_status"), names.join(", "));
    assert.ok(names.includes("o3de_set_intellisense_engine"), names.join(", "));
    assert.ok(names.includes("o3de_update_clangd_database"), names.join(", "));
  });

  test("o3de_intellisense_status reports the engine, both extension installs, and the status rows", async () => {
    const result = await client!.callTool({ name: "o3de_intellisense_status", arguments: {} });
    const report = payload<IntelliSenseReport>(result);
    assert.ok(["cpptools", "clangd", "both", "none"].includes(report.engine.running));
    assert.strictEqual(typeof report.engine.cppToolsStopsAfterReload, "boolean");
    assert.strictEqual(report.engine.clangdOnly, false, "neither extension is installed in the test host");
    assert.strictEqual(report.extensions.cppTools.id, "ms-vscode.cpptools");
    assert.strictEqual(report.extensions.clangd.id, "llvm-vs-code-extensions.vscode-clangd");
    assert.strictEqual(typeof report.extensions.clangd.installed, "boolean");
    assert.strictEqual(typeof report.extensions.clangd.server.found, "boolean");
    assert.strictEqual(report.clangdDatabase.state, "notInUse", "clangd isn't installed here");
    assert.ok(report.clangdDatabase.label, "clangd database row");
    assert.ok(report.engineSources.label, "engine sources row");
    assert.ok(report.cppData.label, "C++ data row");
    assert.ok(report.luaReflection.label, "Lua reflection row");
  });

  test("o3de_set_intellisense_engine refuses when it can't switch, and writes nothing", async () => {
    const result = await client!.callTool({ name: "o3de_set_intellisense_engine", arguments: { engine: "clangd" } });
    assert.strictEqual(result.isError, true);
    const outcome = payload<EngineSwitchResult>(result);
    assert.ok(!outcome.ok, "refused");
    assert.ok(["noWorkspace", "notInstalled"].includes(outcome.reason), outcome.reason);
    assert.strictEqual(state.get("o3de.intellisense.enginePrior"), undefined, "no prior values recorded → no settings written");
  });

  test("o3de_update_clangd_database does nothing while clangd isn't using O3DE's database — not an error", async () => {
    const result = await client!.callTool({ name: "o3de_update_clangd_database", arguments: {} });
    assert.notStrictEqual(result.isError, true);
    const outcome = payload<SyncOutcome>(result);
    assert.ok(!outcome.ran, "didn't run");
    assert.ok(["clangdNotInstalled", "notInUse"].includes(outcome.reason), outcome.reason);
  });

  test("an engine outside cpptools | clangd is rejected", async () => {
    let rejected = false;
    try {
      const result = await client!.callTool({ name: "o3de_set_intellisense_engine", arguments: { engine: "vim" } });
      rejected = result.isError === true;
    } catch {
      rejected = true; // rejected as a protocol error — also a refusal
    }
    assert.ok(rejected);
  });
});
