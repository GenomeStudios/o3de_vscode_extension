// ============================================================================
//  Guided actions — the acquisition layer. Executes a dependency's GuidedAction:
//  the fastest, most-automated way to get/enable the missing piece.
// ============================================================================

import * as vscode from "vscode";
import { execFile } from "child_process";
import { log } from "../log";
import { GuidedAction } from "./registry";
import { extensionPageUrl, hostExtensionGallery } from "./extensionGallery";
import { CLANGD_EXTENSION_ID } from "../constants";
import { discoverEngines } from "../o3de/discovery";
import { readProject } from "../o3de/identity";
import * as fs from "fs";
import * as path from "path";

export async function runGuidedAction(action: GuidedAction): Promise<void> {
  log().info(`Guided action: ${action.kind} ${action.payload}`);
  switch (action.kind) {
    case "command":
      await vscode.commands.executeCommand(action.payload);
      break;
    case "url":
      await vscode.env.openExternal(vscode.Uri.parse(action.payload));
      break;
    case "extension":
      await installExtension(action.payload);
      break;
    case "winget":
      installPackage(action.payload);
      break;
    case "longpaths":
      enableLongPaths();
      break;
    case "enableGem":
      enableGem(action.payload);
      break;
    case "addToPath":
      await addToUserPath(action.payload);
      break;
  }
}

// ---- VS Code extension install (fully automated) ---------------------------
//
// Installs through the editor's OWN marketplace — the in-app command uses whatever
// gallery this editor is built against (VS Code → Visual Studio Marketplace, VSCodium
// → Open VSX). If that fails (e.g. the extension isn't published there), open the
// extension's page on that same marketplace. Never a hardcoded store: sending a
// VSCodium user to the Visual Studio Marketplace is a link they may not use.

async function installExtension(id: string): Promise<void> {
  const gallery = hostExtensionGallery();
  const from = gallery.host ? ` from ${gallery.host}` : "";
  try {
    await vscode.commands.executeCommand("workbench.extensions.installExtension", id);
    if (id === CLANGD_EXTENSION_ID) {
      await recordClangdConflictWarningSeen();
    }
    void vscode.window.showInformationMessage(`Installing "${id}"${from} — reload if prompted.`);
  } catch (err) {
    log().warn(`In-app install of ${id} failed${from}: ${String(err)}`);
    const page = extensionPageUrl(gallery, id);
    if (page) {
      await vscode.env.openExternal(vscode.Uri.parse(page));
    } else {
      void vscode.window.showWarningMessage(
        `This editor has no extension marketplace configured. Install "${id}" from a .vsix file.`,
      );
    }
  }
}

// ---- Package install (winget on Windows, native pkg mgr note elsewhere) -----

function installPackage(id: string): void {
  if (process.platform === "win32") {
    runInTerminal("O3DE: Install", `winget install -e --id ${id} --accept-package-agreements --accept-source-agreements`);
  } else {
    void vscode.window.showInformationMessage(
      `Install "${id}" with your platform's package manager (e.g. apt/dnf/pacman), then re-check.`,
    );
  }
}

// ---- clangd's conflict warning — only when O3DE installed clangd -----------
//
// clangd warns every 5 s while the C/C++ extension's IntelliSense is on, and its "Disable IntelliSense"
// button turns C/C++ IntelliSense off in the USER settings — for every project. When O3DE is the one
// installing clangd, record exactly what clangd's own "Never show this warning" button records
// (`clangd.detectExtensionConflicts: false`, user scope), so that offer never appears; O3DE's engine
// switch decides which engine runs instead. A clangd installed some other way is left as it is.
//
// clangd reads the flag once, when it starts. VS Code rejects writing a setting until the extension that
// declares it is registered, so a rejected first write is retried as soon as the extension list changes.

const CLANGD_REGISTRATION_WAIT_MS = 15000;

async function recordClangdConflictWarningSeen(): Promise<void> {
  const write = (): Thenable<void> =>
    vscode.workspace.getConfiguration("clangd").update("detectExtensionConflicts", false, vscode.ConfigurationTarget.Global);
  try {
    await write();
    log().info("clangd installed by O3DE: recorded clangd.detectExtensionConflicts = false (clangd's 'Never show this warning').");
    return;
  } catch {
    // not registered yet — wait for clangd's contributions to load
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        subscription.dispose();
        clearTimeout(timer);
        resolve();
      }
    };
    const subscription = vscode.extensions.onDidChange(() => {
      write().then(
        () => {
          log().info("clangd installed by O3DE: recorded clangd.detectExtensionConflicts = false after registration.");
          finish();
        },
        () => undefined, // still not registered — keep waiting
      );
    });
    const timer = setTimeout(() => {
      log().warn("clangd installed, but its settings didn't register in time — the conflict-warning flag was not recorded.");
      finish();
    }, CLANGD_REGISTRATION_WAIT_MS);
  });
}

// ---- Add a folder to the user PATH (no elevation) --------------------------
//
// USER scope through .NET's SetEnvironmentVariable — never `setx`, which silently truncates
// PATH at 1024 characters. The folder travels in an environment variable, not spliced into the
// script, so a path containing quotes can't break or inject into the PowerShell command.
// Already present (case-insensitive, trailing backslash ignored) → nothing is written.
// The running editor inherited its PATH at launch, so the change is only seen after quitting
// and reopening it — a window reload is not enough, and we don't pretend it is.

export const ADD_TO_USER_PATH_SCRIPT = [
  "$dir = $env:O3DE_ADD_TO_PATH.TrimEnd('\\')",
  "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
  "$parts = @(); if ($current) { $parts = @($current -split ';' | Where-Object { $_ }) }",
  // if/else stay ONE element: joining with "; " between them makes PowerShell run `else` as a command.
  "if (@($parts | ForEach-Object { $_.TrimEnd('\\') }) -contains $dir) { 'present' } " +
    "else { $updated = (@($parts) + $dir) -join ';'; [Environment]::SetEnvironmentVariable('Path', $updated, 'User'); 'added' }",
].join("; ");

function addToUserPath(dir: string): Promise<void> {
  if (process.platform !== "win32") {
    void vscode.window.showInformationMessage(`Add "${dir}" to your PATH, then restart the editor.`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ADD_TO_USER_PATH_SCRIPT],
      { env: { ...process.env, O3DE_ADD_TO_PATH: dir }, windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) {
          log().error(`Adding ${dir} to the user PATH failed: ${String(err)}`);
          void vscode.window.showErrorMessage(`O3DE: couldn't add "${dir}" to your PATH — ${err.message}`);
        } else {
          const outcome = stdout.trim().endsWith("present") ? "is already on" : "was added to";
          log().info(`User PATH: ${dir} ${outcome} it.`);
          void vscode.window.showInformationMessage(
            `O3DE: "${dir}" ${outcome} your user PATH. Quit and reopen the editor so builds can find clang.`,
          );
        }
        resolve();
      },
    );
  });
}

// ---- Enable Windows long paths (needs elevation) ---------------------------

function enableLongPaths(): void {
  if (process.platform !== "win32") {
    return;
  }
  const psCommand =
    "New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' " +
    "-Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force; " +
    "Write-Host 'Long paths enabled. A reboot may be required.'";
  // Self-elevating: launches an admin PowerShell to write the HKLM key.
  runInTerminal(
    "O3DE: Enable Long Paths",
    `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command',"${psCommand}"`,
  );
}

// ---- Enable an O3DE gem on the active project (via the o3de CLI) ------------

function enableGem(gemName: string): void {
  const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => readProject(f.uri.fsPath));
  const o3de = o3deCliPath();
  if (!folder || !o3de) {
    void vscode.window.showInformationMessage(
      `Enable the "${gemName}" gem on your project (Project Manager → Gems, or 'o3de enable-gem -gn ${gemName}'), then re-check.`,
    );
    return;
  }
  runInTerminal("O3DE: Enable Gem", `& "${o3de}" enable-gem -gn ${gemName} -pp "${folder.uri.fsPath}"`);
}

// Best-effort locate the o3de CLI (scripts/o3de.bat|sh) from a registered engine.
function o3deCliPath(): string | undefined {
  const script = process.platform === "win32" ? "o3de.bat" : "o3de.sh";
  const engines = discoverEngines();
  for (const engine of engines) {
    const candidate = path.join(engine.path, "scripts", script);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// ---- helper ----------------------------------------------------------------

function runInTerminal(name: string, command: string): void {
  const term = vscode.window.createTerminal(name);
  term.show();
  term.sendText(command);
}
