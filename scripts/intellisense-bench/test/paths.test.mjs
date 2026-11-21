import assert from "node:assert/strict";
import { test } from "node:test";
import { extOf, hasPathSuffix, isUnder, normalizePath, pathKey, pathToUri, uriToPath } from "../lib/paths.mjs";

// ============================================================================
//  normalising and comparing
// ============================================================================

test("normalizePath: slashes, trailing slash, dot segments", () => {
  assert.equal(normalizePath("D:\\a\\b\\"), "D:/a/b");
  assert.equal(normalizePath("D:/a//b/./c/../d"), "D:/a/b/d");
  assert.equal(normalizePath("D:/"), "D:/");
  assert.equal(normalizePath("/home/x/"), "/home/x");
});

test("normalizePath keeps a UNC prefix", () => {
  assert.equal(normalizePath("\\\\server\\share\\x"), "//server/share/x");
});

test("pathKey ignores case and slash style", () => {
  assert.equal(pathKey("D:\\OffLocalDev\\Gs_Play"), pathKey("d:/offlocaldev/gs_play/"));
});

test("isUnder: prefix on a segment boundary, case-insensitive", () => {
  assert.equal(isUnder("D:/Dev/gs_play/Gem/a.cpp", "d:/dev/GS_PLAY"), true);
  assert.equal(isUnder("D:/Dev/gs_play", "D:/Dev/gs_play"), true);
  assert.equal(isUnder("D:/Dev/gs_play_gems/a.cpp", "D:/Dev/gs_play"), false); // sibling with the same prefix
  assert.equal(isUnder("D:/x/a.cpp", "D:/"), true);
});

test("hasPathSuffix: whole segments only, case-insensitive", () => {
  assert.equal(hasPathSuffix("d:/o3de/Code/Framework/AzCore/AzCore/Component/Entity.cpp", "AzCore/Component/Entity.cpp"), true);
  assert.equal(hasPathSuffix("d:/o3de/Code/Framework/AzCore/AzCore/Component/Entity.cpp", "azcore\\component\\ENTITY.CPP"), true);
  assert.equal(hasPathSuffix("d:/o3de/XAzCore/Component/Entity.cpp", "AzCore/Component/Entity.cpp"), false);
  assert.equal(hasPathSuffix("d:/a/b.cpp", "/a/b.cpp"), true); // a leading slash on the suffix is ignored
  assert.equal(hasPathSuffix("d:/a/b.cpp", ""), false);
});

test("extOf is lower-case and includes the dot", () => {
  assert.equal(extOf("D:/x/Foo.CPP"), ".cpp");
  assert.equal(extOf("D:/x/Makefile"), "");
});

// ============================================================================
//  file URIs
// ============================================================================

test("uriToPath: the VS Code / clangd Windows form", () => {
  assert.equal(uriToPath("file:///d%3A/x"), "d:/x");
  assert.equal(uriToPath("file:///D:/x/y.cpp"), "D:/x/y.cpp");
  assert.equal(uriToPath("file:///c%3A/Users/some%20one/a%23b.cpp"), "c:/Users/some one/a#b.cpp");
});

test("uriToPath: POSIX and UNC", () => {
  assert.equal(uriToPath("file:///home/me/a.cpp"), "/home/me/a.cpp");
  assert.equal(uriToPath("file://server/share/a.cpp"), "//server/share/a.cpp");
});

test("uriToPath rejects non-file URIs", () => {
  assert.throws(() => uriToPath("untitled:Untitled-1"), /Not a file URI/);
});

test("pathToUri: drive letter lower-cased and colon escaped", () => {
  assert.equal(pathToUri("d:/x"), "file:///d%3A/x");
  assert.equal(pathToUri("D:\\x y\\a#b.cpp"), "file:///d%3A/x%20y/a%23b.cpp");
  assert.equal(pathToUri("/home/me/a.cpp"), "file:///home/me/a.cpp");
});

test("path <-> uri round trip, including non-ASCII (the drive letter comes back lower-case)", () => {
  for (const p of ["d:/OffLocalDev/gs_play/Gem/Code/a.cpp", "C:/Users/Zoë Müller/projekt/日本語.cpp", "/tmp/a b/c.h"]) {
    assert.equal(pathKey(uriToPath(pathToUri(p))), pathKey(p));
  }
  assert.equal(uriToPath(pathToUri("C:/Users/Zoë/日本語.cpp")), "c:/Users/Zoë/日本語.cpp");
});
