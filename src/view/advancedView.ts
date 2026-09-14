// ============================================================================
//  Advanced view — manage extra CMake configure flags (issue #18).
//
//  A dedicated webview (below the Lua Palette) that edits the per-project setting
//  `o3de.cmake.configureArgs` (a map of cache VAR -> value). Curated toggles for
//  the common ones (RenderDoc, CMAKE_OBJECT_PATH_MAX) plus a generic add/remove
//  list for anything else. Editing only updates the setting; an Apply button runs
//  Configure to actually push the flags into CMakeCache. A "reconfigure pending"
//  hint shows whenever the stored flags differ from the cache. A home for future
//  advanced functionality too.
// ============================================================================

import * as vscode from "vscode";
import { firstWorkspaceProject } from "../build/projectResolve";
import { readCmakeCache, readCmakeFlags, writeCmakeFlags } from "../build/configureArgs";
import { readCachedValue } from "../build/configureCommand";
import { getNonce } from "./webviewUtil";

// ---- Curated flags ---------------------------------------------------------
interface CuratedFlag {
  key: string;
  label: string;
  kind: "toggle" | "number";
  onValue?: string; // toggle: the value written when ON (absent = off / CMake default)
  placeholder?: string; // number: hint
  help: string;
}

const CURATED_FLAGS: CuratedFlag[] = [
  {
    key: "LY_RENDERDOC_ENABLED",
    label: "RenderDoc",
    kind: "toggle",
    onValue: "ON",
    help: "Enable RenderDoc graphics debugging (works with the Ninja generator).",
  },
  {
    key: "CMAKE_OBJECT_PATH_MAX",
    label: "Object path max",
    kind: "number",
    placeholder: "1000",
    help: "Raise CMake's max object-file path length — fixes long-path build failures.",
  },
];
const CURATED_KEYS = new Set(CURATED_FLAGS.map((f) => f.key));

// ---- View model ------------------------------------------------------------
interface CustomFlag {
  key: string;
  value: string;
  applied: boolean; // matches the value in CMakeCache
}
interface AdvancedModel {
  hasProject: boolean;
  projectName?: string;
  configured: boolean;
  curated: (CuratedFlag & { value?: string; applied: boolean })[];
  custom: CustomFlag[];
  pending: boolean; // any flag differs from CMakeCache
}

export class AdvancedViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "o3de.advanced";
  private subs: vscode.Disposable[] = [];

  // ---- Setting I/O (per project folder) ------------------------------------
  //  Shared with Configure and the MCP config tools (build/configureArgs.ts).
  private readArgs(): Record<string, string> {
    const project = firstWorkspaceProject();
    return project ? readCmakeFlags(project.path) : {};
  }

  private async writeArgs(args: Record<string, string>): Promise<void> {
    const project = firstWorkspaceProject();
    if (project) {
      await writeCmakeFlags(project.path, args);
    }
  }

  // ---- Model (setting + CMakeCache) ----------------------------------------
  private model(): AdvancedModel {
    const project = firstWorkspaceProject();
    if (!project) {
      return { hasProject: false, configured: false, curated: [], custom: [], pending: false };
    }
    const args = this.readArgs();
    const cacheText = readCmakeCache(project.path) ?? "";
    const configured = cacheText !== "";
    const cachedFor = (key: string): string | undefined => (configured ? readCachedValue(cacheText, key) : undefined);
    // A flag is "applied" when the cache already holds its exact value.
    const isApplied = (key: string, value: string): boolean => configured && cachedFor(key) === value;

    const curated = CURATED_FLAGS.map((flag) => ({
      ...flag,
      value: args[flag.key],
      applied: flag.key in args ? isApplied(flag.key, args[flag.key]) : true, // unset flag = nothing to apply
    }));
    const custom = Object.keys(args)
      .filter((k) => !CURATED_KEYS.has(k))
      .sort()
      .map((key) => ({ key, value: args[key], applied: isApplied(key, args[key]) }));

    const pending = [...curated.filter((c) => c.key in args), ...custom].some((f) => !f.applied);
    return { hasProject: true, projectName: project.projectName, configured, curated, custom, pending };
  }

  // ---- Webview lifecycle ---------------------------------------------------
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview;
    webview.options = { enableScripts: true };
    webview.html = this.html();

    const post = (): void => void webview.postMessage({ type: "model", model: this.model() });

    webview.onDidReceiveMessage(async (msg: { type?: string; key?: string; value?: string }) => {
      if (msg.type === "refresh") {
        post();
        return;
      }
      if (msg.type === "apply") {
        await vscode.commands.executeCommand("o3de.configureProject");
        post(); // pending clears once the user's Configure finishes and the view refreshes
        return;
      }
      if (msg.type === "setArg" && msg.key) {
        const args = this.readArgs();
        if (msg.value === undefined || msg.value === "") {
          delete args[msg.key];
        } else {
          args[msg.key] = msg.value;
        }
        await this.writeArgs(args);
        post();
        return;
      }
      if (msg.type === "removeArg" && msg.key) {
        const args = this.readArgs();
        delete args[msg.key];
        await this.writeArgs(args);
        post();
      }
    });

    this.disposeSubs();
    this.subs.push(
      // React to external edits of the setting (hand-edited settings.json, etc.).
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("o3de.cmake.configureArgs")) {
          post();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => post()),
      // Re-read the cache when the view is revealed (a Configure may have finished).
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          post();
        }
      }),
    );
    webviewView.onDidDispose(() => this.disposeSubs());
    post();
  }

  private disposeSubs(): void {
    for (const s of this.subs) {
      s.dispose();
    }
    this.subs = [];
  }

  // ---- HTML ----------------------------------------------------------------
  private html(): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const curatedJson = JSON.stringify(CURATED_FLAGS);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 10px; }
    h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; margin: 14px 0 6px; }
    .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
    .row label { flex: 1; }
    .row .help { display: block; font-size: 11px; opacity: .6; }
    input[type=text], input[type=number] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 6px; border-radius: 3px; }
    input[type=number] { width: 90px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .toggle { cursor: pointer; user-select: none; padding: 2px 10px; border-radius: 3px; border: 1px solid var(--vscode-checkbox-border, var(--vscode-input-border, #666)); }
    .toggle.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
    .custom-row { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
    .custom-row .k { flex: 1; }
    .custom-row .v { flex: 1; }
    .x { cursor: pointer; opacity: .6; padding: 0 4px; }
    .x:hover { opacity: 1; }
    .pending { margin: 10px 0 4px; padding: 6px 8px; border-radius: 3px; background: var(--vscode-inputValidation-warningBackground, rgba(255,190,0,.12)); border: 1px solid var(--vscode-inputValidation-warningBorder, #b80); font-size: 12px; }
    .applybar { margin-top: 10px; display: flex; gap: 8px; align-items: center; }
    .muted { opacity: .6; font-size: 12px; }
    .add { display: flex; gap: 6px; margin-top: 6px; }
    .add input { flex: 1; }
  </style>
</head>
<body>
  <div id="app"><p class="muted">Loading…</p></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const CURATED = ${curatedJson};
    const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const post = (m) => vscode.postMessage(m);

    function render(model) {
      const app = document.getElementById('app');
      app.innerHTML = '';
      if (!model.hasProject) {
        app.appendChild(el('p', 'muted', 'Open an O3DE project to manage CMake configure flags.'));
        return;
      }

      // Curated
      app.appendChild(el('h3', null, 'CMake Flags'));
      for (const f of model.curated) {
        const row = el('div', 'row');
        const lab = el('label');
        lab.appendChild(document.createTextNode(f.label));
        lab.appendChild(el('span', 'help', f.help));
        row.appendChild(lab);
        if (f.kind === 'toggle') {
          const on = f.value === (f.onValue || 'ON');
          const t = el('span', 'toggle' + (on ? ' on' : ''), on ? 'ON' : 'off');
          t.onclick = () => post({ type: 'setArg', key: f.key, value: on ? '' : (f.onValue || 'ON') });
          row.appendChild(t);
        } else {
          const inp = el('input'); inp.type = 'number'; inp.placeholder = f.placeholder || '';
          inp.value = f.value || '';
          inp.onchange = () => post({ type: 'setArg', key: f.key, value: inp.value.trim() });
          row.appendChild(inp);
        }
        app.appendChild(row);
      }

      // Custom flags
      app.appendChild(el('h3', null, 'Custom -D Flags'));
      if (!model.custom.length) app.appendChild(el('p', 'muted', 'None. Add any CMake cache variable below.'));
      for (const c of model.custom) {
        const r = el('div', 'custom-row');
        r.appendChild(el('span', 'k', c.key));
        const v = el('input', 'v'); v.type = 'text'; v.value = c.value;
        v.onchange = () => post({ type: 'setArg', key: c.key, value: v.value.trim() });
        r.appendChild(v);
        const x = el('span', 'x', '✕'); x.title = 'Remove';
        x.onclick = () => post({ type: 'removeArg', key: c.key });
        r.appendChild(x);
        app.appendChild(r);
      }
      const add = el('div', 'add');
      const k = el('input'); k.type = 'text'; k.placeholder = 'CMAKE_VARIABLE';
      const av = el('input'); av.type = 'text'; av.placeholder = 'value';
      const addBtn = el('button', 'secondary', 'Add');
      const doAdd = () => {
        const key = k.value.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { k.focus(); return; }
        post({ type: 'setArg', key, value: av.value.trim() });
        k.value = ''; av.value = '';
      };
      addBtn.onclick = doAdd;
      k.onkeydown = av.onkeydown = (e) => { if (e.key === 'Enter') doAdd(); };
      add.appendChild(k); add.appendChild(av); add.appendChild(addBtn);
      app.appendChild(add);

      // Pending + apply
      if (model.pending) {
        app.appendChild(el('div', 'pending', '⚠ Flags changed since the last configure — apply to push them into CMakeCache.'));
      } else if (model.configured) {
        app.appendChild(el('p', 'muted', 'All flags applied to the current CMake cache.'));
      } else {
        app.appendChild(el('p', 'muted', 'Project not configured yet — flags apply on the first Configure.'));
      }
      const bar = el('div', 'applybar');
      const apply = el('button', null, 'Apply (Reconfigure)');
      apply.onclick = () => post({ type: 'apply' });
      bar.appendChild(apply);
      app.appendChild(bar);
    }

    window.addEventListener('message', (e) => { if (e.data.type === 'model') render(e.data.model); });
    post({ type: 'refresh' });
  </script>
</body>
</html>`;
  }
}
