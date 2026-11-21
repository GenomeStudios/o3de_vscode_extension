import * as assert from "assert";
import { parseSetOutput, diffEnvironment, scrubVisualStudioEnv } from "../env/msvcEnvironment";

suite("parseSetOutput", () => {
  test("parses KEY=VALUE lines (CRLF)", () => {
    const env = parseSetOutput("PATH=C:\\a;C:\\b\r\nINCLUDE=C:\\inc\r\nEMPTY=\r\n");
    assert.strictEqual(env.PATH, "C:\\a;C:\\b");
    assert.strictEqual(env.INCLUDE, "C:\\inc");
    assert.strictEqual(env.EMPTY, "");
  });

  test("ignores lines without '='", () => {
    const env = parseSetOutput("some banner text\r\nFOO=bar");
    assert.deepStrictEqual(Object.keys(env), ["FOO"]);
  });

  test("keeps '=' characters inside the value", () => {
    assert.strictEqual(parseSetOutput("Q=a=b=c").Q, "a=b=c");
  });
});

suite("diffEnvironment", () => {
  test("returns only new and changed keys", () => {
    const base = { PATH: "C:\\base", KEEP: "same" };
    const full = { PATH: "C:\\vc;C:\\base", KEEP: "same", VCINSTALLDIR: "C:\\vc" };
    const delta = diffEnvironment(base, full);
    assert.strictEqual(delta.PATH, "C:\\vc;C:\\base");
    assert.strictEqual(delta.VCINSTALLDIR, "C:\\vc");
    assert.ok(!("KEEP" in delta));
  });

  test("compares keys case-insensitively", () => {
    assert.deepStrictEqual(diffEnvironment({ Path: "x" }, { PATH: "x" }), {});
  });
});

suite("scrubVisualStudioEnv", () => {
  // What a "Developer Command Prompt for VS 2022" leaves in the environment VS Code was started from.
  const inherited = {
    VSCMD_VER: "17.14.2",
    VSCMD_ARG_HOST_ARCH: "x64",
    __VSCMD_PREINIT_PATH: "C:\\Windows",
    VSINSTALLDIR: "C:\\VS\\2022\\Community\\",
    VCINSTALLDIR: "C:\\VS\\2022\\Community\\VC\\",
    VCToolsVersion: "14.44.35207",
    VCToolsInstallDir: "C:\\VS\\2022\\Community\\VC\\Tools\\MSVC\\14.44.35207\\",
    VCToolsRedistDir: "C:\\redist",
    DevEnvDir: "C:\\VS\\2022\\Community\\Common7\\IDE\\",
    WindowsSdkDir: "C:\\Kits\\10\\",
    WindowsSDKVersion: "10.0.26100.0\\",
    WindowsSDK_ExecutablePath_x64: "C:\\sdk",
    UCRTVersion: "10.0.26100.0",
    UniversalCRTSdkDir: "C:\\Kits\\10\\",
    INCLUDE: "C:\\inc",
    LIB: "C:\\lib",
    LIBPATH: "C:\\libpath",
    EXTERNAL_INCLUDE: "C:\\ext",
    Platform: "x64",
    VisualStudioVersion: "17.0",
    VS170COMNTOOLS: "C:\\VS\\2022\\Community\\Common7\\Tools\\",
  };
  const unrelated = {
    PATH: "C:\\a;C:\\b",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    TEMP: "C:\\tmp",
    PLATFORM_NAME: "keep",
  };

  test("drops every variable a Visual Studio developer prompt sets and keeps the rest", () => {
    assert.deepStrictEqual(scrubVisualStudioEnv({ ...inherited, ...unrelated }), unrelated);
  });

  test("compares names case-insensitively, as Windows does", () => {
    const scrubbed = scrubVisualStudioEnv({ vcinstalldir: "x", Include: "y", vscmd_ver: "z", windowssdkdir: "w", ...unrelated });
    assert.deepStrictEqual(scrubbed, unrelated);
  });

  test("does not modify its input", () => {
    const env = { VSINSTALLDIR: "x", PATH: "p" };
    scrubVisualStudioEnv(env);
    assert.deepStrictEqual(env, { VSINSTALLDIR: "x", PATH: "p" });
  });

  test("an environment with nothing inherited comes back unchanged", () => {
    assert.deepStrictEqual(scrubVisualStudioEnv(unrelated), unrelated);
  });

  // The user's own entries: a machine-wide INCLUDE/LIB that no developer prompt put there.
  const own = {
    INCLUDE: "D:\\vendor\\inc",
    LIB: "D:\\vendor\\lib",
    LIBPATH: "D:\\vendor\\libpath",
    EXTERNAL_INCLUDE: "D:\\vendor\\ext",
    Platform: "x64",
  };

  test("with no developer prompt inherited, the user's own INCLUDE/LIB/LIBPATH/EXTERNAL_INCLUDE/Platform are kept", () => {
    const env = { ...own, ...unrelated };
    const copy = { ...env };
    assert.deepStrictEqual(scrubVisualStudioEnv(env), copy);
    assert.deepStrictEqual(env, copy, "the input is not modified");
  });

  test("the same variables are scrubbed once a developer prompt marker is present, whatever its case", () => {
    for (const marker of ["VSCMD_VER", "vscmd_arg_host_arch", "__VSCMD_PREINIT_PATH", "vcinstalldir", "VSINSTALLDIR"]) {
      assert.deepStrictEqual(scrubVisualStudioEnv({ ...own, ...unrelated, [marker]: "x" }), unrelated, marker);
    }
  });
});
