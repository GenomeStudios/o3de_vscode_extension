import * as assert from "assert";
import {
  BuildDiagnostic,
  BuildResult,
  buildConclusion,
  diagnosticConclusion,
  formatDiagnostic,
  parseBuildOutput,
  summarize,
  tailLines,
} from "../build/buildOutput";

suite("buildOutput.parseBuildOutput", () => {
  test("MSVC compiler error with file(line): code + message", () => {
    const out = String.raw`D:\proj\Gem\Source\Foo.cpp(42): error C2065: 'x': undeclared identifier`;
    const { errors, warnings } = parseBuildOutput(out);
    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(errors, [
      {
        severity: "error",
        file: String.raw`D:\proj\Gem\Source\Foo.cpp`,
        line: 42,
        column: undefined,
        code: "C2065",
        message: "'x': undeclared identifier",
      },
    ]);
  });

  test("MSVC diagnostic with a column and a warning severity", () => {
    const out = String.raw`D:\proj\Foo.cpp(42,10): warning C4189: 'y': local variable is initialized but not referenced`;
    const { errors, warnings } = parseBuildOutput(out);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].column, 10);
    assert.strictEqual(warnings[0].code, "C4189");
    assert.strictEqual(warnings[0].severity, "warning");
  });

  test("fatal error is classified as an error", () => {
    const out = String.raw`D:\proj\Foo.cpp(1): fatal error C1083: Cannot open include file: 'missing.h': No such file or directory`;
    const { errors } = parseBuildOutput(out);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, "C1083");
    assert.strictEqual(errors[0].severity, "error");
  });

  test("linker error (no line) captures file + LNK code", () => {
    const out = [
      `Foo.obj : error LNK2019: unresolved external symbol "void __cdecl Bar(void)"`,
      `D:\\proj\\build\\bin\\Editor.exe : fatal error LNK1120: 1 unresolved externals`,
    ].join("\n");
    const { errors } = parseBuildOutput(out);
    assert.strictEqual(errors.length, 2);
    assert.strictEqual(errors[0].code, "LNK2019");
    assert.strictEqual(errors[0].file, "Foo.obj");
    assert.strictEqual(errors[0].line, undefined);
    assert.strictEqual(errors[1].code, "LNK1120");
  });

  test("CMake located error captures file:line", () => {
    const out = `CMake Error at CMakeLists.txt:12 (find_package):\n  Could not find a package configuration file`;
    const { errors } = parseBuildOutput(out);
    assert.strictEqual(errors.length >= 1, true);
    assert.strictEqual(errors[0].file, "CMakeLists.txt");
    assert.strictEqual(errors[0].line, 12);
    assert.strictEqual(errors[0].code, "CMake");
  });

  test("ninja FAILED marker surfaces as an error", () => {
    const out = `[3/57] Building CXX object Foo.cpp.obj\nFAILED: Gem/Foo.cpp.obj\nninja: build stopped: subcommand failed.`;
    const { errors } = parseBuildOutput(out);
    const codes = errors.map((e) => e.code);
    assert.ok(codes.includes("ninja"));
    assert.strictEqual(errors.some((e) => e.message.startsWith("FAILED:")), true);
  });

  test("identical MSVC errors (re-emitted per TU) are de-duplicated", () => {
    const line = String.raw`D:\proj\Foo.h(9): error C2143: syntax error: missing ';'`;
    const { errors } = parseBuildOutput([line, line, line].join("\n"));
    assert.strictEqual(errors.length, 1);
  });

  test("a clean build produces no diagnostics", () => {
    const out = `[1/3] Building CXX object A.obj\n[2/3] Building CXX object B.obj\n[3/3] Linking Editor.exe`;
    const { errors, warnings } = parseBuildOutput(out);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(warnings, []);
  });
});

suite("buildOutput helpers", () => {
  test("summarize reads out ok/fail with counts and seconds", () => {
    assert.strictEqual(summarize(true, 0, 2, 42100), "Build succeeded — 0 error(s), 2 warning(s) in 42.1s");
    assert.strictEqual(summarize(false, 3, 1, 5000), "Build FAILED — 3 error(s), 1 warning(s) in 5.0s");
  });

  test("tailLines returns the last N lines, trimmed", () => {
    const out = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const tail = tailLines(out, 5);
    assert.strictEqual(tail, ["line 195", "line 196", "line 197", "line 198", "line 199"].join("\n"));
  });
});

// ---- Conclusion printed into the output channel (#29) ----------------------------
suite("buildOutput conclusion", () => {
  const error = (message: string, line = 12): BuildDiagnostic => ({
    severity: "error",
    file: "D:/proj/Code/Foo.cpp",
    line,
    column: 5,
    code: "C2065",
    message,
  });
  const warning: BuildDiagnostic = { severity: "warning", file: "D:/proj/Code/Bar.cpp", line: 3, code: "C4189", message: "unused" };

  test("a diagnostic prints in compiler format, so it stays a clickable file(line) link", () => {
    assert.strictEqual(formatDiagnostic(error("'x': undeclared identifier")), "D:/proj/Code/Foo.cpp(12,5): error C2065: 'x': undeclared identifier");
    assert.strictEqual(formatDiagnostic({ severity: "error", code: "CMake", message: "Could not find package" }), "error CMake: Could not find package");
  });

  test("a failure lists its errors under a count", () => {
    const lines = diagnosticConclusion(false, [error("a"), error("b", 20)], [warning]);
    assert.deepStrictEqual(lines, [
      "2 error(s), 1 warning(s):",
      "  D:/proj/Code/Foo.cpp(12,5): error C2065: a",
      "  D:/proj/Code/Foo.cpp(20,5): error C2065: b",
    ]);
  });

  test("a long error list is capped with a count of the rest", () => {
    const errors = Array.from({ length: 25 }, (_, i) => error(`e${i}`, i + 1));
    const lines = diagnosticConclusion(false, errors, [], 20);
    assert.strictEqual(lines.length, 1 + 20 + 1);
    assert.strictEqual(lines[lines.length - 1], "  … and 5 more error(s)");
  });

  test("a failure with no recognised errors still says where to look", () => {
    assert.match(diagnosticConclusion(false, [], [])[0], /No compiler, linker or CMake errors were recognised/);
  });

  test("a success adds only a warning count, or nothing", () => {
    assert.deepStrictEqual(diagnosticConclusion(true, [], [warning]), ["1 warning(s)."]);
    assert.deepStrictEqual(diagnosticConclusion(true, [], []), []);
  });

  const result = (overrides: Partial<BuildResult>): BuildResult => ({
    ok: false,
    exitCode: 1,
    durationMs: 1000,
    command: "cmake --build",
    targets: [],
    config: "profile",
    errors: [],
    warnings: [],
    summary: "Build FAILED",
    rawTail: "",
    ...overrides,
  });

  test("a build that never started says why", () => {
    assert.deepStrictEqual(buildConclusion(result({ blocked: "not-configured", summary: "The project isn't configured." })), [
      "=== Build not started — The project isn't configured. ===",
    ]);
  });

  test("a stopped build adds nothing after the runner's outcome line", () => {
    assert.deepStrictEqual(buildConclusion(result({ cancelled: true, errors: [error("partial")] })), []);
  });
});
