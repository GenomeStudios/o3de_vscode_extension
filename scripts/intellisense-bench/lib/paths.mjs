// ============================================================================
//  paths.mjs - path and file-URI helpers
//
//  Everything the harness compares goes through here, so Windows quirks live in
//  one place: backslashes, drive-letter case, and the "file:///d%3A/x" URI form
//  that VS Code and clangd use.
//
//    normalizePath   "D:\a\b\"            -> "D:/a/b"
//    pathKey         "D:\a\B"             -> "d:/a/b"        (for comparing)
//    pathToUri       "d:/x y"             -> "file:///d%3A/x%20y"
//    uriToPath       "file:///d%3A/x"     -> "d:/x"
// ============================================================================

import path from "node:path";

// ============================================================================
//  NORMALISING
// ============================================================================

/**
 * Forward slashes, no "." / ".." segments, no trailing slash (except a drive root).
 * Keeps the original letter case; use pathKey() when comparing.
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
  let s = String(p).replaceAll("\\", "/");
  const isUnc = s.startsWith("//");
  s = path.posix.normalize(s);
  if (isUnc && !s.startsWith("//")) s = "/" + s; // posix.normalize collapses the leading //
  if (s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

/**
 * Case-insensitive comparison key.
 * @param {string} p
 * @returns {string}
 */
export function pathKey(p) {
  return normalizePath(p).toLowerCase();
}

// ============================================================================
//  PREFIX / SUFFIX TESTS
// ============================================================================

/**
 * True when `p` is `root` itself or lives under it. Case-insensitive.
 * @param {string} p
 * @param {string} root
 * @returns {boolean}
 */
export function isUnder(p, root) {
  const k = pathKey(p);
  const r = pathKey(root);
  if (k === r) return true;
  return k.startsWith(r.endsWith("/") ? r : r + "/");
}

/**
 * True when `p` ends with `suffix` on a path-segment boundary.
 * "x/AzCore/Entity.cpp" ends with "AzCore/Entity.cpp" but not with "Core/Entity.cpp".
 * @param {string} p
 * @param {string} suffix
 * @returns {boolean}
 */
export function hasPathSuffix(p, suffix) {
  const k = pathKey(p);
  const s = pathKey(suffix).replace(/^\/+/, "");
  if (!s) return false;
  return k === s || k.endsWith("/" + s);
}

/**
 * Throw unless `target` is strictly inside `parent`. Every write and delete is guarded by this.
 * @param {string} parent
 * @param {string} target
 */
export function assertInside(parent, target) {
  if (pathKey(parent) === pathKey(target) || !isUnder(target, parent)) {
    throw new Error(`Refusing to touch "${target}": not inside "${parent}"`);
  }
}

/**
 * Lower-case file extension including the dot ("" when none).
 * @param {string} p
 * @returns {string}
 */
export function extOf(p) {
  return path.posix.extname(normalizePath(p)).toLowerCase();
}

// ============================================================================
//  FILE URIs
// ============================================================================

/**
 * Path -> file URI in the VS Code style: drive letter lower-cased, colon escaped.
 * @param {string} p
 * @returns {string}
 */
export function pathToUri(p) {
  const n = normalizePath(p);
  const encode = (s) => s.split("/").map(encodeURIComponent).join("/");
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(n);
  if (drive) return `file:///${drive[1].toLowerCase()}%3A${encode(drive[2] ?? "/")}`;
  if (n.startsWith("//")) return `file:${encode(n)}`; // UNC: file://server/share/x
  return `file://${encode(n)}`; // POSIX: file:///home/x
}

/**
 * File URI -> normalised path. Accepts "file:///d%3A/x" and "file:///D:/x".
 * @param {string} uri
 * @returns {string}
 */
export function uriToPath(uri) {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri);
  if (!m) throw new Error(`Not a file URI: ${uri}`);
  const host = m[1];
  let p = decodeURIComponent(m[2] ?? "/");
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // "/d:/x" -> "d:/x"
  else if (host && host.toLowerCase() !== "localhost") p = "//" + host + p; // UNC
  return normalizePath(p);
}
