// ============================================================================
//  Select Visual Studio — the picker behind "O3DE: Select Visual Studio Version"
//  and the dashboard's Visual Studio row.
//
//  Offers "Auto (newest)" and one row per Visual Studio detected on this machine;
//  the choice is saved to o3de.build.visualStudio in the USER settings. The rules
//  live in visualStudio.ts and the setting in visualStudioPreference.ts; this file
//  is only the UI.
// ============================================================================

import * as vscode from "vscode";
import { isVsPreference, pickInstall, findVisualStudioInstalls, vsYear, VisualStudioInstall, VsPreference } from "./visualStudio";
import { readVsPreference, selectInstall, writeVsPreference } from "./visualStudioPreference";

export interface VsPickItem extends vscode.QuickPickItem {
  preference?: VsPreference; // what the row selects; absent for an install whose year cannot be pinned
}

// ---- Items (testable) --------------------------------------------------------
const joinParts = (parts: (string | false | undefined)[]): string => parts.filter(Boolean).join(" · ");

/** "Auto (newest)" first, then one row per detected install; the row in force is marked "(current)". */
export function vsPickItems(installs: VisualStudioInstall[], current: VsPreference): VsPickItem[] {
  const auto = pickInstall(installs, "auto");
  const inForce = pickInstall(installs, current);
  const items: VsPickItem[] = [
    {
      label: "Auto (newest)",
      description: joinParts([auto ? `now ${auto.displayName}` : "no Visual Studio found", current === "auto" && "(current)"]),
      preference: "auto",
    },
  ];
  for (const install of installs) {
    const year = vsYear(install);
    const preference = isVsPreference(year) ? year : undefined;
    items.push({
      label: install.displayName,
      description: joinParts([
        install.version,
        !install.hasCppTools && "no C++ tools",
        preference === undefined && "cannot be selected (2019, 2022 or 2026 only)",
        current !== "auto" && install === inForce && "(current)",
      ]),
      detail: install.installationPath,
      preference,
    });
  }
  return items;
}

// ---- Command -----------------------------------------------------------------
export async function selectVisualStudio(): Promise<void> {
  const installs = await findVisualStudioInstalls();
  selectInstall(installs); // remember them, so the dashboard row can describe the new pick
  const pick = await vscode.window.showQuickPick(vsPickItems(installs, readVsPreference()), {
    title: "O3DE: Select Visual Studio Version",
    placeHolder: "Which Visual Studio's MSVC environment Configure, Build and the Developer terminal use",
  });
  if (!pick) {
    return; // cancelled — leave the setting alone
  }
  if (pick.preference === undefined) {
    void vscode.window.showInformationMessage(`O3DE: ${pick.label} cannot be selected — only Visual Studio 2019, 2022 and 2026 can.`);
    return;
  }

  const written = await writeVsPreference(pick.preference);
  if (written.overriddenBy) {
    void vscode.window.showWarningMessage(
      `O3DE: saved to your user settings, but this ${written.overriddenBy}'s o3de.build.visualStudio is ` +
        `"${written.effective}" and wins. Edit or remove that value to use ${pick.preference}.`,
    );
    return;
  }
  void vscode.window.showInformationMessage(
    `O3DE: Visual Studio set to ${pick.preference}. An existing build tree keeps the compiler it was configured with — ` +
      "delete build/windows/CMakeCache.txt and CMakeFiles, then Configure, to switch it.",
  );
}
