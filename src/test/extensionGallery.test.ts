// ============================================================================
//  Extension gallery + optional extensions in onboarding.
//
//  Gallery shapes are the real ones: Visual Studio Code's product.json (read from
//  the installed test build) and VSCodium's, whose build injects Open VSX.
// ============================================================================

import * as assert from "assert";
import { extensionPageUrl, galleryFrom, hostExtensionGallery } from "../deps/extensionGallery";
import { buildOnboardingModel, CHECKS, isBlocking, ResultMap } from "../deps/registry";

const VSCODE_PRODUCT = {
  nameLong: "Visual Studio Code",
  extensionsGallery: {
    serviceUrl: "https://marketplace.visualstudio.com/_apis/public/gallery",
    itemUrl: "https://marketplace.visualstudio.com/items",
  },
};
const VSCODIUM_PRODUCT = {
  nameLong: "VSCodium",
  extensionsGallery: { serviceUrl: "https://open-vsx.org/vscode/gallery", itemUrl: "https://open-vsx.org/vscode/item" },
};
const CODE_OSS_PRODUCT = { nameLong: "Code - OSS" }; // no gallery configured at all
const CLANGD = "llvm-vs-code-extensions.vscode-clangd";

// ---- Gallery resolution ------------------------------------------------------
suite("extensionGallery.galleryFrom", () => {
  test("Visual Studio Code → the Visual Studio Marketplace", () => {
    const gallery = galleryFrom(VSCODE_PRODUCT, {});
    assert.strictEqual(gallery.host, "marketplace.visualstudio.com");
    assert.strictEqual(gallery.source, "product");
  });

  test("VSCodium → Open VSX", () => {
    assert.strictEqual(galleryFrom(VSCODIUM_PRODUCT, {}).host, "open-vsx.org");
  });

  test("VSCODE_GALLERY_ITEM_URL wins over product.json — the editor honours it the same way", () => {
    const gallery = galleryFrom(VSCODE_PRODUCT, { VSCODE_GALLERY_ITEM_URL: "https://open-vsx.org/vscode/item" });
    assert.strictEqual(gallery.host, "open-vsx.org");
    assert.strictEqual(gallery.source, "env");
  });

  test("INTEGRATION: reads the running editor's real product.json (versioned install folder)", () => {
    // The suite runs inside a downloaded Visual Studio Code build, so this exercises the real appRoot path.
    const gallery = hostExtensionGallery();
    assert.notStrictEqual(gallery.source, "none", "a real VS Code build has a gallery");
    assert.ok(gallery.itemUrl && gallery.host, `resolved itemUrl/host (got ${JSON.stringify(gallery)})`);
  });

  test("an editor with no marketplace configured → none, never a made-up store", () => {
    assert.deepStrictEqual(galleryFrom(CODE_OSS_PRODUCT, {}), { source: "none" });
    assert.deepStrictEqual(galleryFrom(undefined, {}), { source: "none" });
  });
});

suite("extensionGallery.extensionPageUrl", () => {
  test("builds the page link the editor itself uses: <itemUrl>?itemName=<id>", () => {
    assert.strictEqual(
      extensionPageUrl(galleryFrom(VSCODE_PRODUCT, {}), CLANGD),
      "https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-clangd",
    );
    assert.strictEqual(
      extensionPageUrl(galleryFrom(VSCODIUM_PRODUCT, {}), CLANGD),
      "https://open-vsx.org/vscode/item?itemName=llvm-vs-code-extensions.vscode-clangd",
    );
  });

  test("a trailing slash on itemUrl doesn't double up", () => {
    assert.strictEqual(
      extensionPageUrl({ itemUrl: "https://open-vsx.org/vscode/item/", source: "product" }, CLANGD),
      "https://open-vsx.org/vscode/item?itemName=llvm-vs-code-extensions.vscode-clangd",
    );
  });

  test("no gallery → no link", () => {
    assert.strictEqual(extensionPageUrl({ source: "none" }, CLANGD), undefined);
  });
});

// ---- clangd in onboarding ----------------------------------------------------
suite("onboarding: clangd optional", () => {
  const clangd = CHECKS.find((c) => c.id === "clangd");

  test("is registered as a C++-view optional with an in-app extension install", () => {
    assert.ok(clangd, "clangd check exists");
    assert.strictEqual(clangd!.tier, "optional");
    assert.strictEqual(clangd!.track, "optional");
    assert.deepStrictEqual(clangd!.views, ["cpp"]);
    assert.deepStrictEqual(clangd!.action, { label: "Install clangd", kind: "extension", payload: CLANGD });
  });

  test("sits right after CMake Tools in the C++ optionals", () => {
    const ids = CHECKS.map((c) => c.id);
    assert.strictEqual(ids.indexOf("clangd"), ids.indexOf("cmakeTools") + 1);
  });

  test("shows under the C++ view only, and never blocks even when not installed", () => {
    const results: ResultMap = { clangd: { state: "absent", detail: "Not installed" } };
    assert.ok(buildOnboardingModel(results, "cpp", "win32").optionals.some((v) => v.id === "clangd"));
    assert.ok(!buildOnboardingModel(results, "lua", "win32").optionals.some((v) => v.id === "clangd"));
    assert.strictEqual(isBlocking(clangd!, results.clangd), false);
  });

  test("the row carries its 'Not installed' text and install button while absent", () => {
    const row = buildOnboardingModel({ clangd: { state: "absent", detail: "Not installed" } }, "cpp", "win32").optionals.find(
      (v) => v.id === "clangd",
    );
    assert.strictEqual(row!.detail, "Not installed");
    assert.strictEqual(row!.actionLabel, "Install clangd");
  });
});
