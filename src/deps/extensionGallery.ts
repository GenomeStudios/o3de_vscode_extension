// ============================================================================
//  Extension gallery — which marketplace THIS editor installs extensions from.
//
//  Every VS Code-based editor ships a product.json whose `extensionsGallery`
//  decides where its Extensions view (and `workbench.extensions.installExtension`)
//  fetches from. Verified values:
//    Visual Studio Code   itemUrl https://marketplace.visualstudio.com/items
//    VSCodium             itemUrl https://open-vsx.org/vscode/item   (injected by its build)
//  An editor can also be pointed elsewhere with VSCODE_GALLERY_ITEM_URL, which
//  wins when set. Reading this is structural — never a guess from the app's name.
//
//  The editor builds an extension's page link as `<itemUrl>?itemName=<id>`; we
//  use the same convention for the fallback when an in-app install fails.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// ---- Model -----------------------------------------------------------------
export interface ExtensionGallery {
  itemUrl?: string; // undefined → this editor has no marketplace configured (e.g. a bare Code - OSS build)
  host?: string; // "marketplace.visualstudio.com", "open-vsx.org", …
  source: "env" | "product" | "none";
}

// ---- Pure ------------------------------------------------------------------
/** Resolve the gallery from an editor's product.json content and its environment. */
export function galleryFrom(product: unknown, env: Record<string, string | undefined>): ExtensionGallery {
  const fromEnv = env.VSCODE_GALLERY_ITEM_URL?.trim();
  if (fromEnv) {
    return { itemUrl: fromEnv, host: hostOf(fromEnv), source: "env" };
  }
  const itemUrl = (product as { extensionsGallery?: { itemUrl?: unknown } } | undefined)?.extensionsGallery?.itemUrl;
  if (typeof itemUrl === "string" && itemUrl.trim()) {
    return { itemUrl: itemUrl.trim(), host: hostOf(itemUrl), source: "product" };
  }
  return { source: "none" };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** The extension's page on this editor's marketplace, or undefined when it has none. */
export function extensionPageUrl(gallery: ExtensionGallery, extensionId: string): string | undefined {
  return gallery.itemUrl ? `${gallery.itemUrl.replace(/\/+$/, "")}?itemName=${encodeURIComponent(extensionId)}` : undefined;
}

// ---- Host editor -----------------------------------------------------------
/** The marketplace the running editor installs from. */
export function hostExtensionGallery(): ExtensionGallery {
  let product: unknown;
  try {
    product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8"));
  } catch {
    product = undefined; // unreadable product.json → treat as no configured gallery
  }
  return galleryFrom(product, process.env);
}
