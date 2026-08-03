import * as assert from "assert";
import {
  OutputFilter,
  collapseCarriageReturns,
  parseNinjaProgress,
  progressLabel,
  progressPercent,
  stripAnsi,
} from "../build/outputStream";

// Control characters are built here rather than typed as escapes so the test
// source stays plain ASCII.
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

suite("outputStream.stripAnsi", () => {
  test("removes CSI colour sequences, keeps the text", () => {
    const coloured = `${ESC}[32m[12/99] Building CXX object${ESC}[0m`;
    assert.strictEqual(stripAnsi(coloured), "[12/99] Building CXX object");
  });

  test("leaves plain text untouched", () => {
    const plain = String.raw`D:\proj\Gem\Source\Foo.cpp(42): error C2065: 'x'`;
    assert.strictEqual(stripAnsi(plain), plain);
  });
});

suite("outputStream.collapseCarriageReturns", () => {
  test("keeps only what the terminal would have left visible", () => {
    assert.strictEqual(collapseCarriageReturns(`10%${CR}55%${CR}100%`), "100%");
  });

  test("drops the CRLF remnant left by splitting on newline", () => {
    assert.strictEqual(collapseCarriageReturns(`Linking Editor.exe${CR}`), "Linking Editor.exe");
  });

  test("a line with no carriage return is unchanged", () => {
    assert.strictEqual(collapseCarriageReturns("ninja: build stopped."), "ninja: build stopped.");
  });
});

suite("outputStream.parseNinjaProgress", () => {
  test("reads the [n/m] pair off a ninja edge line", () => {
    assert.deepStrictEqual(parseNinjaProgress("[412/1337] Building CXX object Gem/x.cpp.obj"), {
      current: 412,
      total: 1337,
    });
  });

  test("ignores lines that merely start with a bracket", () => {
    assert.strictEqual(parseNinjaProgress("[warning] not progress"), undefined);
    assert.strictEqual(parseNinjaProgress("FAILED: Editor.exe"), undefined);
  });

  test("percent and label derive from the pair; absent pair is inert", () => {
    const p = { current: 412, total: 1337 };
    assert.strictEqual(progressPercent(p), 31);
    assert.strictEqual(progressLabel(p), "412/1337 - 31%");
    assert.strictEqual(progressPercent(undefined), 0);
    assert.strictEqual(progressLabel(undefined), "");
    // A zero/absent total must not produce NaN or Infinity.
    assert.strictEqual(progressPercent({ current: 5, total: 0 }), 0);
  });
});

suite("outputStream.OutputFilter", () => {
  // A controllable clock so the throttle is tested without real timers.
  function fixedClock(): { now: () => number; advance: (ms: number) => void } {
    let t = 10_000;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  }

  test("non-progress lines always pass through immediately", () => {
    const filter = new OutputFilter({ now: fixedClock().now });
    const { lines } = filter.push("cmake configure step\nCMake Error: boom\n");
    assert.deepStrictEqual(lines, ["cmake configure step", "CMake Error: boom"]);
  });

  test("progress lines are throttled to a heartbeat", () => {
    const clock = fixedClock();
    const filter = new OutputFilter({ progressIntervalMs: 500, now: clock.now });

    // First progress line fires the tick (last tick was at time 0).
    const first = filter.push("[1/100] a\n");
    assert.deepStrictEqual(first.lines, ["[1/100] a"]);
    assert.deepStrictEqual(first.progress, { current: 1, total: 100 });

    // Same instant: the next 3 are held back, not displayed.
    const held = filter.push("[2/100] b\n[3/100] c\n[4/100] d\n");
    assert.deepStrictEqual(held.lines, []);
    assert.strictEqual(held.progress, undefined);
    // ...but the newest pair is still tracked for the progress readout.
    assert.deepStrictEqual(filter.progress, { current: 4, total: 100 });

    // Past the interval, the NEWEST held line is released (not the stale ones).
    clock.advance(500);
    const after = filter.push("[5/100] e\n");
    assert.deepStrictEqual(after.lines, ["[5/100] e"]);
    assert.deepStrictEqual(after.progress, { current: 5, total: 100 });
  });

  test("a real message releases the held progress line first, for context", () => {
    const clock = fixedClock();
    const filter = new OutputFilter({ progressIntervalMs: 500, now: clock.now });
    filter.push("[1/100] a\n"); // consumes the first tick
    filter.push("[2/100] Building Foo.cpp\n"); // held (same instant)

    // The error must arrive UNDER the line naming the file being compiled.
    const { lines } = filter.push("Foo.cpp(42): error C2065: 'x'\n");
    assert.deepStrictEqual(lines, ["[2/100] Building Foo.cpp", "Foo.cpp(42): error C2065: 'x'"]);
  });

  test("lines split across chunks are rejoined", () => {
    const filter = new OutputFilter({ now: fixedClock().now });
    assert.deepStrictEqual(filter.push("Foo.cpp(42): err").lines, []);
    assert.deepStrictEqual(filter.push("or C2065: 'x'\n").lines, ["Foo.cpp(42): error C2065: 'x'"]);
  });

  test("flush releases the last held progress line and an unterminated tail", () => {
    const clock = fixedClock();
    const filter = new OutputFilter({ progressIntervalMs: 500, now: clock.now });
    filter.push("[1/100] a\n"); // consumes the first tick
    filter.push("[99/100] almost\n"); // held back
    filter.push("no trailing newline here"); // partial

    const { lines } = filter.flush();
    assert.deepStrictEqual(lines, ["[99/100] almost", "no trailing newline here"]);
    // Flushing twice must not re-emit anything.
    assert.deepStrictEqual(filter.flush().lines, []);
  });

  test("ANSI and CR shaping apply to streamed lines", () => {
    const filter = new OutputFilter({ now: fixedClock().now });
    const { lines } = filter.push(`${ESC}[33m10%${CR}100% linked${ESC}[0m\n`);
    assert.deepStrictEqual(lines, ["100% linked"]);
  });
});
