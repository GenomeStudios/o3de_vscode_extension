import * as assert from "assert";
import {
  cachedCompilerMismatch,
  compilerMismatchWarning,
  explainSelection,
  isVsPreference,
  parseVsWhereJson,
  pickBestInstall,
  pickInstall,
  selectionProblem,
  vsMajor,
  vsYear,
  VisualStudioInstall,
} from "../env/visualStudio";

suite("parseVsWhereJson", () => {
  test("parses a typical vswhere JSON payload", () => {
    const json = JSON.stringify([
      {
        displayName: "Visual Studio Community 2022",
        installationPath: "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community",
        installationVersion: "17.10.35013.160",
        isPrerelease: false,
      },
    ]);
    const parsed = parseVsWhereJson(json);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].displayName, "Visual Studio Community 2022");
    assert.ok(parsed[0].installationPath.includes("2022"));
    assert.strictEqual(parsed[0].version, "17.10.35013.160");
    assert.strictEqual(parsed[0].isPrerelease, false);
  });

  test("returns [] on empty or malformed input", () => {
    assert.deepStrictEqual(parseVsWhereJson(""), []);
    assert.deepStrictEqual(parseVsWhereJson("not json"), []);
    assert.deepStrictEqual(parseVsWhereJson("{}"), []);
  });

  test("skips entries without an installationPath", () => {
    const json = JSON.stringify([{ displayName: "Broken" }, { installationPath: "C:\\VS" }]);
    const parsed = parseVsWhereJson(json);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].installationPath, "C:\\VS");
  });

  test("falls back to a default display name", () => {
    const json = JSON.stringify([{ installationPath: "C:\\VS" }]);
    assert.strictEqual(parseVsWhereJson(json)[0].displayName, "Visual Studio");
  });
});

suite("pickBestInstall", () => {
  const mk = (version: string, hasCppTools: boolean): VisualStudioInstall => ({
    displayName: version,
    installationPath: `C:\\VS\\${version}`,
    version,
    isPrerelease: false,
    hasCppTools,
  });

  test("prefers the newest version among C++-capable installs", () => {
    const best = pickBestInstall([mk("16.11.1", true), mk("17.14.2", true), mk("17.9.9", false)]);
    assert.strictEqual(best?.version, "17.14.2");
  });

  test("prefers a C++-capable install over a newer one without C++ tools", () => {
    const best = pickBestInstall([mk("17.20.0", false), mk("17.10.0", true)]);
    assert.strictEqual(best?.version, "17.10.0");
  });

  test("returns undefined for empty input", () => {
    assert.strictEqual(pickBestInstall([]), undefined);
  });
});

// ---- Selection (o3de.build.visualStudio) -------------------------------------
// The owner's machine: 2019 (16.11), 2022 (17.14) and 2026 (18.11) side by side. "Newest" is always 2026.
const install = (displayName: string, version: string, hasCppTools = true): VisualStudioInstall => ({
  displayName,
  installationPath: `C:\\Program Files\\Microsoft Visual Studio\\${displayName}`,
  version,
  isPrerelease: false,
  hasCppTools,
});
const vs2019 = install("Visual Studio Community 2019", "16.11.40");
const vs2022 = install("Visual Studio Community 2022", "17.14.2");
const vs2026 = install("Visual Studio Community 2026", "18.11.12315.225");
const all = [vs2019, vs2022, vs2026];

suite("vsMajor / vsYear", () => {
  test("the year comes from the version's major: 16 / 17 / 18 -> 2019 / 2022 / 2026", () => {
    assert.strictEqual(vsMajor("18.11.12315.225"), 18);
    assert.strictEqual(vsYear(vs2019), "2019");
    assert.strictEqual(vsYear(vs2022), "2022");
    assert.strictEqual(vsYear(vs2026), "2026");
  });

  test("15 reads as 2017 for display, an unknown major as v<major>, an unreadable version as undefined", () => {
    assert.strictEqual(vsYear({ version: "15.9.1" }), "2017");
    assert.strictEqual(vsYear({ version: "19.0.1" }), "v19");
    assert.strictEqual(vsMajor("unknown"), undefined);
    assert.strictEqual(vsYear({ version: "unknown" }), undefined);
  });

  test("only auto and the pinnable years are preferences", () => {
    for (const ok of ["auto", "2019", "2022", "2026"]) {
      assert.strictEqual(isVsPreference(ok), true, ok);
    }
    for (const bad of ["2017", "2030", "", "Auto", undefined, 2022]) {
      assert.strictEqual(isVsPreference(bad), false, String(bad));
    }
  });
});

suite("pickInstall", () => {
  test("auto is pickBestInstall: the newest, so 2026 on a machine that also has 2022", () => {
    assert.strictEqual(pickInstall(all, "auto"), pickBestInstall(all));
    assert.strictEqual(pickInstall(all, "auto"), vs2026);
  });

  test("a year pins that version even when a newer one is installed and C++-capable", () => {
    assert.strictEqual(pickInstall(all, "2022"), vs2022);
    assert.strictEqual(pickInstall(all, "2019"), vs2019);
    assert.strictEqual(pickInstall(all, "2026"), vs2026);
  });

  test("a pinned year that is not installed selects nothing (no silent fallback)", () => {
    assert.strictEqual(pickInstall([vs2019, vs2026], "2022"), undefined);
    assert.strictEqual(pickInstall([], "auto"), undefined);
  });

  test("two installs of the same year: the C++-capable one, then the newest", () => {
    const buildTools = install("Visual Studio Build Tools 2022", "17.9.0", false);
    const older = install("Visual Studio Professional 2022", "17.8.5");
    assert.strictEqual(pickInstall([buildTools, vs2022, older], "2022"), vs2022);
    assert.strictEqual(pickInstall([older, vs2022], "2022"), vs2022, "the newer of two C++-capable installs");
    assert.strictEqual(pickInstall([buildTools, older], "2022"), older, "C++ tools beat a newer install without them");
  });

  test("a pinned install without the C++ tools is still returned, so the guard can say so", () => {
    const noCpp = install("Visual Studio Community 2022", "17.14.2", false);
    assert.strictEqual(pickInstall([noCpp, vs2026], "2022"), noCpp);
    assert.strictEqual(pickInstall([noCpp, vs2026], "auto"), vs2026);
  });

  test("an install with an unreadable version (the fallback probe) never matches a pin", () => {
    const probed = install("Visual Studio Community 2022", "unknown");
    assert.strictEqual(pickInstall([probed], "2022"), undefined);
    assert.strictEqual(pickInstall([probed, vs2026], "2026"), vs2026);
    assert.strictEqual(pickInstall([probed], "auto"), probed, "auto still takes what the probe found");
  });
});

suite("explainSelection / selectionProblem", () => {
  test("a pinned year that is not installed names what was found", () => {
    assert.strictEqual(
      explainSelection("2022", [vs2026]),
      "Visual Studio 2022 is selected (o3de.build.visualStudio) but not installed. Found: Visual Studio Community 2026.",
    );
    assert.match(explainSelection("2019", [vs2022, vs2026]), /Found: Visual Studio Community 2022, Visual Studio Community 2026\./);
  });

  test("an install whose version cannot be read is called out", () => {
    const probed = install("Visual Studio Community 2022", "unknown");
    assert.match(explainSelection("2022", [probed]), /1 of them could not report a version/);
  });

  test("nothing installed, whatever the selection", () => {
    assert.strictEqual(explainSelection("auto", []), "No Visual Studio installation was found.");
    assert.strictEqual(explainSelection("2022", []), "No Visual Studio installation was found.");
  });

  test("selectionProblem: none selected, no C++ tools, or fine", () => {
    assert.match(selectionProblem("2022", [vs2026], undefined) ?? "", /2022 is selected/);
    const noCpp = install("Visual Studio Community 2022", "17.14.2", false);
    assert.strictEqual(selectionProblem("2022", [noCpp], noCpp), "Visual Studio Community 2022 lacks the MSVC C++ toolset.");
    assert.strictEqual(selectionProblem("2022", all, vs2022), undefined);
  });
});

suite("cachedCompilerMismatch", () => {
  const cache = (compiler: string): string =>
    `CMAKE_BUILD_TYPE:STRING=\nCMAKE_CXX_COMPILER:FILEPATH=${compiler}\nCMAKE_GENERATOR:INTERNAL=Ninja Multi-Config\n`;
  const root2022 = "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community";
  const cl2022 = "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/cl.exe";
  const cl2026 = "C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231/bin/Hostx64/x64/cl.exe";

  test("a compiler under the selected install is no mismatch", () => {
    assert.strictEqual(cachedCompilerMismatch(cache(cl2022), root2022), undefined);
  });

  test("an MSVC compiler from another install is the mismatch, and is returned as cached", () => {
    assert.strictEqual(cachedCompilerMismatch(cache(cl2026), root2022), cl2026);
  });

  test("slash direction, case and a trailing slash do not matter", () => {
    const backslashes = cl2022.replace(/\//g, "\\").toUpperCase();
    assert.strictEqual(cachedCompilerMismatch(cache(backslashes), root2022.toLowerCase() + "\\"), undefined);
    assert.strictEqual(cachedCompilerMismatch(cache(cl2022), "c:/program files/microsoft visual studio/2022/community/"), undefined);
  });

  test("an install whose path merely starts the same is not the same install", () => {
    assert.strictEqual(cachedCompilerMismatch(cache(cl2022), "C:\\Program Files\\Microsoft Visual Studio\\2022\\Comm"), cl2022);
  });

  test("a compiler outside Visual Studio (clang, gcc) is ignored", () => {
    assert.strictEqual(cachedCompilerMismatch(cache("C:/Program Files/LLVM/bin/clang-cl.exe"), root2022), undefined);
    assert.strictEqual(cachedCompilerMismatch(cache("/usr/bin/g++"), root2022), undefined);
  });

  test("a cache without CMAKE_CXX_COMPILER says nothing", () => {
    assert.strictEqual(cachedCompilerMismatch("CMAKE_GENERATOR:INTERNAL=Ninja Multi-Config\n", root2022), undefined);
    assert.strictEqual(cachedCompilerMismatch("", root2022), undefined);
  });

  test("the warning names the build tree, the cached compiler, the selection and the remedy", () => {
    const line = compilerMismatchWarning("D:\\proj\\build\\windows", cl2026, "Visual Studio Community 2022");
    assert.ok(line.startsWith(`D:\\proj\\build\\windows was configured with ${cl2026}; the selected Visual Studio is Visual Studio Community 2022.`));
    assert.match(line, /delete CMakeCache\.txt and CMakeFiles and Configure/);
  });
});
