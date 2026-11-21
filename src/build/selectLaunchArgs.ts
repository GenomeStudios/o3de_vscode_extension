// ============================================================================
//  Select Launch Args — the picker behind the Launch Options row.
//
//  With no history yet it is the plain input box (one step, as before). Once
//  launch options have been used it offers the recent values to switch back to,
//  "Type new arguments…", "Clear launch options", and a way to forget entries.
//  The remembering itself lives in BuildOptions.setLaunchArgs; the list rules
//  are in launchArgsHistory.ts. This file is only the UI.
// ============================================================================

import * as vscode from "vscode";
import { BuildOptions } from "./buildOptions";
import { removeLaunchArgsHistory } from "./launchArgsHistory";
import { launchArgsLabel } from "./runCommand";

const TITLE = "O3DE: Launch Options";

type LaunchArgsAction = "type" | "clear" | "pick" | "remove";

interface LaunchArgsItem extends vscode.QuickPickItem {
  action?: LaunchArgsAction; // what the row does (absent on separators)
  args?: string; // the history entry a "pick" row applies
}

interface HistoryEntryItem extends vscode.QuickPickItem {
  args: string;
}

// ---- Command -----------------------------------------------------------------
export async function selectLaunchArgs(options: BuildOptions): Promise<void> {
  const history = options.launchArgsHistory;
  if (history.length === 0) {
    await typeLaunchArgs(options); // nothing to choose from yet
    return;
  }

  const current = options.launchArgs.trim();
  const items: LaunchArgsItem[] = [{ label: "$(edit) Type new arguments…", action: "type" }];
  if (current !== "") {
    items.push({ label: "$(clear-all) Clear launch options", action: "clear" });
  }
  items.push({ label: "recent", kind: vscode.QuickPickItemKind.Separator });
  for (const args of history) {
    items.push({ label: args, description: args === current ? "(current)" : undefined, action: "pick", args });
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "$(trash) Remove entries from history…", action: "remove" });

  const pick = await vscode.window.showQuickPick(items, {
    title: TITLE,
    placeHolder: `Current: ${launchArgsLabel(options.launchArgs)}`,
  });
  if (!pick) {
    return; // cancelled — leave everything unchanged
  }

  switch (pick.action) {
    case "type":
      await typeLaunchArgs(options);
      break;
    case "clear":
      await options.setLaunchArgs("");
      break;
    case "pick":
      await options.setLaunchArgs(pick.args ?? "");
      break;
    case "remove":
      await removeFromHistory(options);
      break;
  }
}

// ---- Steps -------------------------------------------------------------------
/** The free-form input box, prefilled with the current args (blank clears). */
async function typeLaunchArgs(options: BuildOptions): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: TITLE,
    prompt: "Extra command-line args passed when running (blank to clear)",
    placeHolder: "+LoadLevel DefaultLevel +r_displayInfo 1",
    value: options.launchArgs,
  });
  if (value !== undefined) {
    await options.setLaunchArgs(value);
  }
}

/** Multi-select the history entries to forget. The current launch options are not touched. */
async function removeFromHistory(options: BuildOptions): Promise<void> {
  const entries: HistoryEntryItem[] = options.launchArgsHistory.map((args) => ({ label: args, args }));
  const picks = await vscode.window.showQuickPick(entries, {
    title: "O3DE: Remove Launch Options From History",
    placeHolder: "Tick the entries to forget",
    canPickMany: true,
  });
  if (!picks || picks.length === 0) {
    return;
  }
  const remaining = picks.reduce((list, pick) => removeLaunchArgsHistory(list, pick.args), options.launchArgsHistory);
  await options.setLaunchArgsHistory(remaining);
}
