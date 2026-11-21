// ============================================================================
//  MCP Visual Studio tools (#38) -- the selection in o3de_get_config /
//  o3de_set_config and the read-only o3de_visual_studio_status, end to end
//  through the real MCP SDK client. The selection is a USER setting, so every
//  test restores the user's own value afterwards. Which Visual Studios exist
//  depends on the machine, so those checks adapt (and skip when there is
//  nothing to prove); the platform branches are asserted both ways.
// ============================================================================

import * as assert from "assert";
import * as vscode from "vscode";
import type { ConfigSnapshot } from "../build/configQuery";
import type { VisualStudioStatus } from "../env/visualStudioQuery";
import { McpHarness, payload, startMcpHarness, summaryLine } from "./mcpHarness";

const onWindows = process.platform === "win32";

const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("o3de");
const setGlobal = (value: string | undefined): Thenable<void> =>
  config().update("build.visualStudio", value, vscode.ConfigurationTarget.Global);

suite("MCP Visual Studio tools (end to end)", () => {
  let mcp: McpHarness | undefined;
  let original: string | undefined;

  suiteSetup(async () => {
    mcp = await startMcpHarness();
    original = config().inspect<string>("build.visualStudio")?.globalValue;
    await setGlobal(undefined); // start from the default whatever the user has set
  });

  suiteTeardown(async () => {
    await setGlobal(original);
    await mcp?.close();
  });

  teardown(async () => {
    await setGlobal(undefined);
  });

  const status = async (captureEnvironment?: boolean): Promise<VisualStudioStatus> =>
    payload<VisualStudioStatus>(await mcp!.client.callTool({ name: "o3de_visual_studio_status", arguments: { captureEnvironment } }));

  // ---- Listing ---------------------------------------------------------------
  test("o3de_visual_studio_status is listed, read-only, with an optional captureEnvironment", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((t) => t.name === "o3de_visual_studio_status");
    assert.ok(tool, "o3de_visual_studio_status missing");
    assert.strictEqual(tool.annotations?.readOnlyHint, true);
    assert.strictEqual(tool.annotations?.openWorldHint, false);
    assert.ok("captureEnvironment" in (tool.inputSchema.properties ?? {}));
    assert.strictEqual(tool.inputSchema.required, undefined);
    assert.match(tool.description ?? "", /"O3DE Developer \(MSVC\)" terminal profile start with exactly\s+this\s+environment/);
  });

  test("o3de_set_config offers visualStudio as auto / 2019 / 2022 / 2026", async () => {
    const tool = (await mcp!.client.listTools()).tools.find((t) => t.name === "o3de_set_config");
    const properties = (tool?.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
    assert.deepStrictEqual([...(properties.visualStudio?.enum ?? [])].sort(), ["2019", "2022", "2026", "auto"]);
  });

  // ---- o3de_get_config -------------------------------------------------------
  test("o3de_get_config reports the selection on Windows and nothing elsewhere", async () => {
    const snapshot = payload<ConfigSnapshot>(await mcp!.client.callTool({ name: "o3de_get_config", arguments: {} }));
    if (!onWindows) {
      assert.strictEqual(snapshot.visualStudio, undefined);
      return;
    }
    assert.strictEqual(snapshot.visualStudio?.preference, "auto");
    assert.deepStrictEqual(snapshot.visualStudio?.options, ["auto", "2019", "2022", "2026"]);
    assert.strictEqual(typeof snapshot.visualStudio?.selection, "string");
    assert.strictEqual(snapshot.visualStudio?.overriddenBy, undefined);
  });

  // ---- o3de_set_config -------------------------------------------------------
  test("o3de_set_config visualStudio round-trips through the USER setting (Windows) / is an error (elsewhere)", async () => {
    const result = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { visualStudio: "2022" } });
    if (!onWindows) {
      assert.strictEqual(result.isError, true);
      assert.match(summaryLine(result), /Windows-only/);
      assert.strictEqual(config().inspect<string>("build.visualStudio")?.globalValue, undefined, "nothing was written");
      return;
    }
    assert.notStrictEqual(result.isError, true);
    assert.match(summaryLine(result), /Updated: visualStudio/);
    assert.strictEqual(payload<ConfigSnapshot>(result).visualStudio?.preference, "2022", "the value in force");
    assert.strictEqual(config().inspect<string>("build.visualStudio")?.globalValue, "2022", "saved to the user settings");

    const back = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { visualStudio: "auto" } });
    assert.strictEqual(payload<ConfigSnapshot>(back).visualStudio?.preference, "auto");
  });

  test("o3de_set_config refuses a patch with a Visual Studio selection off Windows without changing its other fields", async function () {
    if (onWindows) {
      return this.skip(); // the refusal is the off-Windows branch
    }
    const before = mcp!.buildOptions.config;
    const config2 = before === "debug" ? "release" : "debug";
    const result = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { config: config2, visualStudio: "2022" } });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(mcp!.buildOptions.config, before, "a refused patch changes nothing");
  });

  test("o3de_set_config rejects a value that is not auto or a pinnable year", async () => {
    let rejected = false;
    try {
      const result = await mcp!.client.callTool({ name: "o3de_set_config", arguments: { visualStudio: "2030" } });
      rejected = result.isError === true;
    } catch {
      rejected = true;
    }
    assert.strictEqual(rejected, true);
    assert.strictEqual(config().inspect<string>("build.visualStudio")?.globalValue, undefined);
  });

  // ---- o3de_visual_studio_status ---------------------------------------------
  test("o3de_visual_studio_status reports the documented shape (supported:false off Windows)", async () => {
    const report = await status();
    assert.strictEqual(report.preference, "auto");
    if (!onWindows) {
      assert.strictEqual(report.supported, false);
      assert.deepStrictEqual(report.installs, []);
      assert.match(report.problem ?? "", /Windows-only/);
      return;
    }
    assert.strictEqual(report.supported, true);
    assert.ok(Array.isArray(report.installs));
    for (const install of report.installs) {
      assert.strictEqual(typeof install.displayName, "string");
      assert.strictEqual(typeof install.installationPath, "string");
      assert.strictEqual(typeof install.hasCppTools, "boolean");
      assert.strictEqual(typeof install.selected, "boolean");
    }
    assert.strictEqual(report.installs.filter((i) => i.selected).length, report.selected ? 1 : 0);
    assert.strictEqual(report.environment, undefined, "only when asked for");
  });

  test("a pinned year is the one the status reports as selected, and its environment is that install's", async function () {
    if (!onWindows) {
      return this.skip();
    }
    this.timeout(60_000);
    const pinnable = (await status()).installs.filter((i) => ["2019", "2022", "2026"].includes(i.year ?? "") && i.hasCppTools);
    if (pinnable.length === 0) {
      return this.skip(); // no Visual Studio with the C++ tools on this machine
    }
    for (const install of pinnable) {
      await mcp!.client.callTool({ name: "o3de_set_config", arguments: { visualStudio: install.year as "2019" | "2022" | "2026" } });
      const report = await status(true);
      assert.strictEqual(report.preference, install.year);
      assert.strictEqual(report.selected?.year, install.year, `${install.year} selected`);
      assert.ok(report.environment, "the environment was captured");
      assert.strictEqual(report.environment?.error, undefined);
      assert.match(report.environment?.VCToolsVersion ?? "", /^\d+\.\d+/);
      assert.ok(
        report.environment?.VSINSTALLDIR?.toLowerCase().startsWith(report.selected?.installationPath.toLowerCase() ?? "?"),
        `VSINSTALLDIR ${report.environment?.VSINSTALLDIR} is under the pinned install ${report.selected?.installationPath}`,
      );
      assert.match(report.environment?.clPath ?? "", /cl\.exe$/i);
    }
  });

  test("a pinned year that is not installed is reported as a problem, with no selection", async function () {
    if (!onWindows) {
      return this.skip();
    }
    const installed = new Set((await status()).installs.map((i) => i.year));
    const missing = (["2019", "2022", "2026"] as const).find((year) => !installed.has(year));
    if (!missing) {
      return this.skip(); // every pinnable year is installed here
    }
    await mcp!.client.callTool({ name: "o3de_set_config", arguments: { visualStudio: missing } });
    const report = await status();
    assert.strictEqual(report.selected, undefined);
    assert.match(report.problem ?? "", new RegExp(`Visual Studio ${missing} is selected \\(o3de\\.build\\.visualStudio\\) but not installed`));
  });
});
