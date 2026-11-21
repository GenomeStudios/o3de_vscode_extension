import * as assert from "assert";
import * as path from "path";
import {
  buildConfigureArgs,
  formatCommand,
  parseCachedGenerator,
  readCachedValue,
  resolveThirdPartyPath,
} from "../build/configureCommand";

suite("configureCommand", () => {
  test("buildConfigureArgs emits the O3DE Ninja configure argv", () => {
    const argv = buildConfigureArgs({
      projectPath: "D:/OffLocalDev/CurvesTest",
      buildDir: "D:/OffLocalDev/CurvesTest/build/windows",
      generator: "Ninja Multi-Config",
      thirdPartyPath: "C:/Users/x/.o3de/3rdParty",
    });
    assert.deepStrictEqual(argv, [
      "cmake",
      "-G",
      "Ninja Multi-Config",
      "-S",
      "D:/OffLocalDev/CurvesTest",
      "-B",
      "D:/OffLocalDev/CurvesTest/build/windows",
      "-DLY_3RDPARTY_PATH=C:/Users/x/.o3de/3rdParty",
    ]);
  });

  test("buildConfigureArgs appends extra cache flags as sorted -D VAR=value", () => {
    const argv = buildConfigureArgs({
      projectPath: "P",
      buildDir: "B",
      generator: "Ninja Multi-Config",
      thirdPartyPath: "T",
      extraCacheArgs: { LY_RENDERDOC_ENABLED: "ON", CMAKE_OBJECT_PATH_MAX: "1000" },
    });
    // Sorted by key -> CMAKE_OBJECT_PATH_MAX before LY_RENDERDOC_ENABLED, both last.
    assert.deepStrictEqual(argv.slice(-2), [
      "-DCMAKE_OBJECT_PATH_MAX=1000",
      "-DLY_RENDERDOC_ENABLED=ON",
    ]);
  });

  test("buildConfigureArgs with no extra flags is unchanged", () => {
    const argv = buildConfigureArgs({
      projectPath: "P",
      buildDir: "B",
      generator: "Ninja Multi-Config",
      thirdPartyPath: "T",
      extraCacheArgs: {},
    });
    assert.strictEqual(argv.includes("-DCMAKE_OBJECT_PATH_MAX=1000"), false);
    assert.strictEqual(argv[argv.length - 1], "-DLY_3RDPARTY_PATH=T");
  });

  test("a user LY_3RDPARTY_PATH replaces the default and is emitted once, in the default's slot", () => {
    const argv = buildConfigureArgs({
      projectPath: "P",
      buildDir: "B",
      generator: "Ninja Multi-Config",
      thirdPartyPath: "T",
      extraCacheArgs: { LY_3RDPARTY_PATH: "/custom", LY_RENDERDOC_ENABLED: "ON" },
    });
    assert.deepStrictEqual(
      argv.filter((token) => token.startsWith("-DLY_3RDPARTY_PATH=")),
      ["-DLY_3RDPARTY_PATH=/custom"],
    );
    assert.strictEqual(argv[argv.indexOf("-B") + 2], "-DLY_3RDPARTY_PATH=/custom");
    assert.strictEqual(argv[argv.length - 1], "-DLY_RENDERDOC_ENABLED=ON");
  });

  test("an empty or whitespace user LY_3RDPARTY_PATH is dropped, never blanking the default", () => {
    for (const blank of ["", "   "]) {
      const argv = buildConfigureArgs({
        projectPath: "P",
        buildDir: "B",
        generator: "Ninja Multi-Config",
        thirdPartyPath: "T",
        extraCacheArgs: { LY_3RDPARTY_PATH: blank },
      });
      assert.deepStrictEqual(
        argv.filter((token) => token.startsWith("-DLY_3RDPARTY_PATH=")),
        ["-DLY_3RDPARTY_PATH=T"],
      );
    }
  });

  test("resolveThirdPartyPath: the Advanced flag beats the manifest, which beats the home default", () => {
    const home = path.join("home", "x");
    assert.deepStrictEqual(resolveThirdPartyPath("M", { LY_3RDPARTY_PATH: "/custom" }, home), {
      path: "/custom",
      source: "advanced-flag",
    });
    assert.deepStrictEqual(resolveThirdPartyPath("M", {}, home), { path: "M", source: "manifest" });
    assert.deepStrictEqual(resolveThirdPartyPath(undefined, undefined, home), {
      path: path.join(home, ".o3de", "3rdParty"),
      source: "default",
    });
  });

  test("resolveThirdPartyPath: a blank Advanced flag is ignored, a padded one is returned unmodified", () => {
    assert.deepStrictEqual(resolveThirdPartyPath("M", { LY_3RDPARTY_PATH: "  " }, "h"), {
      path: "M",
      source: "manifest",
    });
    assert.deepStrictEqual(resolveThirdPartyPath("M", { LY_3RDPARTY_PATH: " /custom " }, "h"), {
      path: " /custom ",
      source: "advanced-flag",
    });
  });

  test("formatCommand quotes tokens with spaces / = / path chars, leaves bare flags", () => {
    const cmd = formatCommand([
      "cmake",
      "-G",
      "Ninja Multi-Config",
      "-S",
      "D:\\a b\\proj",
      "-DLY_3RDPARTY_PATH=C:\\x",
    ]);
    assert.strictEqual(
      cmd,
      'cmake -G "Ninja Multi-Config" -S "D:\\a b\\proj" "-DLY_3RDPARTY_PATH=C:\\x"',
    );
  });

  test("parseCachedGenerator reads CMAKE_GENERATOR:INTERNAL", () => {
    const cache = [
      "# This is the CMakeCache file.",
      "CMAKE_BUILD_TYPE:STRING=",
      "CMAKE_GENERATOR:INTERNAL=Ninja Multi-Config",
      "CMAKE_GENERATOR_INSTANCE:INTERNAL=",
    ].join("\n");
    assert.strictEqual(parseCachedGenerator(cache), "Ninja Multi-Config");
  });

  test("parseCachedGenerator returns undefined when the line is absent", () => {
    assert.strictEqual(parseCachedGenerator("SOME_VAR:BOOL=ON\n"), undefined);
  });

  test("readCachedValue reads a NAME:TYPE=VALUE cache entry", () => {
    const cache = [
      "//A comment",
      "LY_RENDERDOC_ENABLED:BOOL=ON",
      "CMAKE_OBJECT_PATH_MAX:STRING=1000",
    ].join("\n");
    assert.strictEqual(readCachedValue(cache, "LY_RENDERDOC_ENABLED"), "ON");
    assert.strictEqual(readCachedValue(cache, "CMAKE_OBJECT_PATH_MAX"), "1000");
    assert.strictEqual(readCachedValue(cache, "MISSING"), undefined);
  });
});
