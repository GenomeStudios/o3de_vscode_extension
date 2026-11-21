// ============================================================================
//  MCP IntelliSense tools — end to end through the real MCP SDK client.
//
//  The test host has no workspace and neither the C/C++ extension nor clangd
//  installed, so the switch must refuse — and write nothing. The cases that need a
//  workspace with an unconfigured O3DE project and clangd installed (a failed switch
//  that keeps the stored setting, clearing the setting while another scope sets it)
//  skip themselves when the host can't reach them; run them in such a dev host.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CLANGD_EXTENSION_ID } from "../constants";
import type { IntelliSenseReport } from "../intellisense/intellisenseQuery";
import type { EngineSwitchResult } from "../intellisense/clangdMode";
import type { SyncOutcome } from "../intellisense/clangdSync";
import { McpHarness, payload, startMcpHarness } from "./mcpHarness";

suite("MCP IntelliSense tools (end to end)", () => {
  let mcp: McpHarness | undefined;

  suiteSetup(async () => {
    mcp = await startMcpHarness();
  });

  suiteTeardown(async () => {
    await mcp?.close();
  });

  test("the IntelliSense tools are listed", async () => {
    const names = (await mcp!.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("o3de_intellisense_status"), names.join(", "));
    assert.ok(names.includes("o3de_set_intellisense_engine"), names.join(", "));
    assert.ok(names.includes("o3de_update_clangd_database"), names.join(", "));
  });

  test("o3de_intellisense_status says it reports the engine module defines count (no project here to produce one)", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((candidate) => candidate.name === "o3de_intellisense_status");
    assert.match(tool?.description ?? "", /engineModuleDefines/);
    assert.strictEqual(tool?.annotations?.readOnlyHint, true);
  });

  test("o3de_intellisense_status says it reports the entry counts by origin and the engine coverage setting", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((candidate) => candidate.name === "o3de_intellisense_status");
    for (const word of ["origins", "engineFramework", "engineGems", "fallback", "engineCoverage"]) {
      assert.match(tool?.description ?? "", new RegExp(word));
    }
  });

  test("o3de_intellisense_status reports the engineCoverage setting — participating until the user changes it", async () => {
    const report = payload<IntelliSenseReport>(await mcp!.client.callTool({ name: "o3de_intellisense_status", arguments: {} }));
    assert.strictEqual(report.engineCoverage.setting, "participating");
    assert.ok(report.engineCoverage.detail.length > 0);
  });

  test("o3de_update_clangd_database takes an optional engineCoverage of participating | framework | off", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((candidate) => candidate.name === "o3de_update_clangd_database");
    const schema = JSON.stringify(tool?.inputSchema);
    for (const value of ["participating", "framework", "off"]) {
      assert.ok(schema.includes(`"${value}"`), `${value} in ${schema}`);
    }
    assert.ok(!((tool?.inputSchema as { required?: string[] } | undefined)?.required ?? []).includes("engineCoverage"), "optional");
    assert.match(tool?.description ?? "", /generation\.origins/);
    assert.strictEqual(tool?.annotations?.readOnlyHint, false);
  });

  test("o3de_intellisense_status reports the engine, both extension installs, and the status rows", async () => {
    const result = await mcp!.client.callTool({ name: "o3de_intellisense_status", arguments: {} });
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
    const result = await mcp!.client.callTool({ name: "o3de_set_intellisense_engine", arguments: { engine: "clangd" } });
    assert.strictEqual(result.isError, true);
    const outcome = payload<EngineSwitchResult>(result);
    assert.ok(!outcome.ok, "refused");
    assert.ok(["noWorkspace", "notInstalled"].includes(outcome.reason), outcome.reason);
    assert.strictEqual(mcp!.state.get("o3de.intellisense.enginePrior"), undefined, "no prior values recorded → no settings written");
  });

  test("o3de_update_clangd_database does nothing while clangd isn't using O3DE's database — not an error", async () => {
    const result = await mcp!.client.callTool({ name: "o3de_update_clangd_database", arguments: {} });
    assert.notStrictEqual(result.isError, true);
    const outcome = payload<SyncOutcome>(result);
    assert.ok(!outcome.ran, "didn't run");
    assert.ok(["clangdNotInstalled", "notInUse"].includes(outcome.reason), outcome.reason);
  });

  test("o3de_update_clangd_database with an engineCoverage override still does nothing while clangd isn't using the database", async () => {
    for (const engineCoverage of ["participating", "framework", "off"]) {
      const result = await mcp!.client.callTool({ name: "o3de_update_clangd_database", arguments: { engineCoverage } });
      assert.notStrictEqual(result.isError, true, engineCoverage);
      assert.ok(!payload<SyncOutcome>(result).ran, engineCoverage);
    }
  });

  test("an engineCoverage outside participating | framework | off is rejected", async () => {
    let rejected = false;
    try {
      const result = await mcp!.client.callTool({ name: "o3de_update_clangd_database", arguments: { engineCoverage: "everything" } });
      rejected = result.isError === true;
    } catch {
      rejected = true; // rejected as a protocol error — also a refusal
    }
    assert.ok(rejected);
  });

  // ---- Bring your own compile database -------------------------------------
  test("o3de_set_intellisense_engine takes an optional string compileDatabase and says what it does", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((candidate) => candidate.name === "o3de_set_intellisense_engine");
    const schema = tool?.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] } | undefined;
    assert.strictEqual(schema?.properties?.compileDatabase?.type, "string");
    assert.ok(!(schema?.required ?? []).includes("compileDatabase"), "optional");
    assert.deepStrictEqual(schema?.required, ["engine"]);
    for (const word of ["o3de.intellisense.compileDatabase", "never writes", "compileDatabase.missing", "compileDatabase.source"]) {
      assert.ok((tool?.description ?? "").includes(word), word);
    }
    assert.strictEqual(tool?.annotations?.readOnlyHint, false);
  });

  test("o3de_intellisense_status says it reports which compile database is selected, and stays read-only", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((candidate) => candidate.name === "o3de_intellisense_status");
    for (const word of ["clangdDatabase.selection", "userProvided", "selection.missing", "selection.hint"]) {
      assert.ok((tool?.description ?? "").includes(word), word);
    }
    assert.strictEqual(tool?.annotations?.readOnlyHint, true);
  });

  test("o3de_intellisense_status has no compile database selection without a project, and nothing to hint at", async () => {
    const report = payload<IntelliSenseReport>(await mcp!.client.callTool({ name: "o3de_intellisense_status", arguments: {} }));
    assert.strictEqual(report.clangdDatabase.selection, undefined);
    assert.notStrictEqual(report.clangdDatabase.state, "userProvided");
  });

  test("o3de_set_intellisense_engine with a compileDatabase refuses when it can't switch, and stores no setting", async () => {
    const result = await mcp!.client.callTool({
      name: "o3de_set_intellisense_engine",
      arguments: { engine: "clangd", compileDatabase: "D:/work/shared/compile_commands.json" },
    });
    assert.strictEqual(result.isError, true);
    const outcome = payload<EngineSwitchResult>(result);
    assert.ok(!outcome.ok, "refused");
    assert.ok(["noWorkspace", "notInstalled", "noProject"].includes(outcome.reason), outcome.reason);
    assert.strictEqual(vscode.workspace.getConfiguration("o3de.intellisense").get("compileDatabase"), "", "the setting is untouched");
    assert.strictEqual(mcp!.state.get("o3de.intellisense.enginePrior"), undefined, "no clangd settings written");
    assert.strictEqual(mcp!.state.get("o3de.intellisense.databaseDir"), undefined, "no database folder recorded");
  });

  test("o3de_set_intellisense_engine says what '' removes, that a failed switch keeps the setting, and when the follow acts", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((candidate) => candidate.name === "o3de_set_intellisense_engine");
    const description = tool?.description ?? "";
    for (const word of ["removes the workspace-folder value", "User or Workspace", "settingWritten", "sole running engine"]) {
      assert.ok(description.includes(word), word);
    }
    const compileDatabase = (tool?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties?.compileDatabase;
    assert.match(compileDatabase?.description ?? "", /removes the workspace-folder value/);
  });

  test("o3de_intellisense_status says it reports the registered gems left out, and what 'last' is for a user's database", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((candidate) => candidate.name === "o3de_intellisense_status");
    for (const word of ["last.skippedManifestGems", "most recent generation", "userProvided"]) {
      assert.ok((tool?.description ?? "").includes(word), word);
    }
  });

  // ---- Needs a workspace with an unconfigured O3DE project and clangd installed ----
  const setting = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("o3de.intellisense");
  const hostCanSwitch = (): boolean => (vscode.workspace.workspaceFolders?.length ?? 0) > 0 && vscode.extensions.getExtension(CLANGD_EXTENSION_ID) !== undefined;

  test("a switch that fails because the project isn't configured keeps the stored setting and says so", async function () {
    if (!hostCanSwitch()) {
      this.skip();
    }
    const before = setting().inspect<string>("compileDatabase")?.workspaceFolderValue;
    try {
      const result = await mcp!.client.callTool({
        name: "o3de_set_intellisense_engine",
        arguments: { engine: "clangd", compileDatabase: "D:/nowhere/compile_commands.json" },
      });
      const outcome = payload<EngineSwitchResult>(result);
      if (outcome.ok || outcome.reason !== "notConfigured") {
        this.skip(); // this host's project is configured, or isn't an O3DE project: the failure under test can't be reached
      }
      assert.strictEqual(result.isError, true);
      assert.strictEqual(!outcome.ok && outcome.settingWritten, true);
      assert.ok(!outcome.ok && outcome.compileDatabase, "the selection is reported on the failure too");
      assert.ok(!outcome.ok && outcome.compileDatabase?.missing, "the path that isn't there is reported on the failure");
      assert.match(!outcome.ok ? outcome.message : "", /was stored; clangd is re-pointed automatically after the next configure/);
      assert.strictEqual(setting().inspect<string>("compileDatabase")?.workspaceFolderValue, "D:/nowhere/compile_commands.json", "the setting stays stored");
    } finally {
      await setting().update("compileDatabase", before, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });

  test("clearing the setting while the User settings still set it reports the user's database, not the generated one", async function () {
    if (!hostCanSwitch()) {
      this.skip();
    }
    const inspected = setting().inspect<string>("compileDatabase");
    const folderBefore = inspected?.workspaceFolderValue;
    const globalBefore = inspected?.globalValue;
    const own = path.join(os.tmpdir(), `o3de-userdb-e2e-${process.pid}`);
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "compile_commands.json"), "[]\n");
    try {
      await setting().update("compileDatabase", own, vscode.ConfigurationTarget.Global);
      const result = await mcp!.client.callTool({ name: "o3de_set_intellisense_engine", arguments: { engine: "clangd", compileDatabase: "" } });
      const outcome = payload<EngineSwitchResult>(result);
      const selection = outcome.compileDatabase;
      if (!selection) {
        this.skip(); // no O3DE project in this host's workspace: the switch refused before reading the setting
      }
      assert.strictEqual(selection.source, "user", "the User value still applies after the folder value was removed");
      assert.match(selection.reason, /still set in your User or Workspace settings/);
    } finally {
      await setting().update("compileDatabase", globalBefore, vscode.ConfigurationTarget.Global);
      await setting().update("compileDatabase", folderBefore, vscode.ConfigurationTarget.WorkspaceFolder);
      fs.rmSync(own, { recursive: true, force: true });
    }
  });

  test("o3de_update_clangd_database says a user-provided database is never updated", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((candidate) => candidate.name === "o3de_update_clangd_database");
    assert.match(tool?.description ?? "", /userDatabase/);
    assert.match(tool?.description ?? "", /never writes it/);
  });

  test("a compileDatabase that isn't a string is rejected", async () => {
    let rejected = false;
    try {
      const result = await mcp!.client.callTool({ name: "o3de_set_intellisense_engine", arguments: { engine: "clangd", compileDatabase: 42 } });
      rejected = result.isError === true;
    } catch {
      rejected = true; // rejected as a protocol error — also a refusal
    }
    assert.ok(rejected);
  });

  test("an engine outside cpptools | clangd is rejected", async () => {
    let rejected = false;
    try {
      const result = await mcp!.client.callTool({ name: "o3de_set_intellisense_engine", arguments: { engine: "vim" } });
      rejected = result.isError === true;
    } catch {
      rejected = true; // rejected as a protocol error — also a refusal
    }
    assert.ok(rejected);
  });
});
