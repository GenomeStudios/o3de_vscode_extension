// ============================================================================
//  writeProjectSettings (issue #36) -- a custom LY_3RDPARTY_PATH from the
//  Advanced tab survives in <project>/.vscode/settings.json, instead of being
//  replaced by the O3DE default. Runs against a temp project folder.
//
//  The test host has no workspace folder, so readCmakeFlags (the workspace
//  setting) returns {} and only the project's own settings.json supplies the
//  flag. That is exactly the setup-wizard case (a project that is not an open
//  workspace folder yet); the readCmakeFlags-over-file precedence is not covered.
// ============================================================================

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BuildOptions } from "../build/buildOptions";
import { resolveThirdPartyPath } from "../build/configureCommand";
import { writeProjectSettings } from "../build/writeProjectConfig";
import { readManifest } from "../o3de/manifest";
import { memoryMemento } from "./mcpHarness";

type Settings = Record<string, unknown>;

suite("writeProjectSettings: the 3rd-party path", () => {
  let dir: string;
  let options: BuildOptions;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "o3de-wps-"));
    options = new BuildOptions(memoryMemento());
  });

  teardown(() => {
    options.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- Helpers -------------------------------------------------------------
  function seed(settings: Settings): void {
    fs.mkdirSync(path.join(dir, ".vscode"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".vscode", "settings.json"), JSON.stringify(settings), "utf8");
  }

  async function write(): Promise<Settings> {
    const written = await writeProjectSettings({ projectName: "WpsTest", path: dir, externalSubdirectories: [], gemNames: [] }, options);
    assert.ok(written, "settings.json was written");
    return JSON.parse(fs.readFileSync(written, "utf8")) as Settings;
  }

  function thirdPartyOf(settings: Settings): unknown {
    return (settings["cmake.configureSettings"] as Settings)["LY_3RDPARTY_PATH"];
  }

  /** What Configure falls back to with no custom path: the manifest default, else ~/.o3de/3rdParty. */
  function defaultThirdParty(): string {
    return resolveThirdPartyPath(readManifest()?.defaultThirdPartyFolder, {}, os.homedir()).path;
  }

  // ---- Cases ---------------------------------------------------------------
  test("a custom LY_3RDPARTY_PATH replaces a stale value and leaves the other settings alone", async () => {
    seed({
      "o3de.cmake.configureArgs": { LY_3RDPARTY_PATH: "X" },
      "cmake.configureSettings": { LY_3RDPARTY_PATH: "old", CUSTOM: "keep" },
    });
    const settings = await write();
    const configure = settings["cmake.configureSettings"] as Settings;
    assert.strictEqual(configure["LY_3RDPARTY_PATH"], "X");
    assert.strictEqual(configure["CUSTOM"], "keep", "other cmake.configureSettings entries are kept");
    assert.deepStrictEqual(settings["o3de.cmake.configureArgs"], { LY_3RDPARTY_PATH: "X" }, "the Advanced-tab flags are untouched");
  });

  test("a blank LY_3RDPARTY_PATH is ignored: the default is written", async () => {
    seed({ "o3de.cmake.configureArgs": { LY_3RDPARTY_PATH: "   " } });
    assert.strictEqual(thirdPartyOf(await write()), defaultThirdParty());
  });

  test("with no settings file at all, the default is written", async () => {
    assert.strictEqual(thirdPartyOf(await write()), defaultThirdParty());
  });

  test("with a settings file that has no such flag, the default is written", async () => {
    seed({ "editor.tabSize": 2 });
    const settings = await write();
    assert.strictEqual(thirdPartyOf(settings), defaultThirdParty());
    assert.strictEqual(settings["editor.tabSize"], 2, "unrelated settings are kept");
  });
});
