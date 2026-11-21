// ============================================================================
//  Process guard (issue #33) -- which guarded images a `tasklist /FO CSV`
//  listing shows. The default table form cuts image names at 25 characters, so
//  the 27-character ScriptCanvasApplication.exe was never detected. The probe
//  itself spawns tasklist and is checked by hand.
// ============================================================================

import * as assert from "assert";
import { guardedImagesListed } from "../build/processGuard";

suite("processGuard", () => {
  suite("guardedImagesListed", () => {
    const row = (image: string): string => `"${image}","4242","Console","1","250,000 K"\r\n`;

    test("finds Editor.exe in a CSV listing", () => {
      assert.deepStrictEqual(guardedImagesListed(row("svchost.exe") + row("Editor.exe")), ["Editor.exe"]);
    });

    test("finds ScriptCanvasApplication.exe, whose 27-character name the table form cut off", () => {
      assert.deepStrictEqual(guardedImagesListed(row("ScriptCanvasApplication.exe")), ["ScriptCanvasApplication.exe"]);
    });

    test("finds both when both are running", () => {
      const listing = row("ScriptCanvasApplication.exe") + row("Editor.exe");
      assert.deepStrictEqual(guardedImagesListed(listing), ["Editor.exe", "ScriptCanvasApplication.exe"]);
    });

    test("finds nothing in an unrelated listing", () => {
      assert.deepStrictEqual(guardedImagesListed(row("explorer.exe") + row("Code.exe")), []);
    });

    test("an exe that merely ends in Editor.exe is not the Editor", () => {
      assert.deepStrictEqual(guardedImagesListed(row("LuaEditor.exe")), []);
    });

    test("the table form still cuts the long name: why the guard reads CSV", () => {
      const table = `${"ScriptCanvasApplication.exe".slice(0, 25)}  4242 Console  1  250,000 K`;
      assert.deepStrictEqual(guardedImagesListed(table), []);
    });
  });
});
