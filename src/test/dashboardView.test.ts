// ============================================================================
//  Dashboard view (#41) — the page must come back showing the CURRENT state.
//
//  VS Code rebuilds a hidden view's page from the html set at resolve time and
//  drops messages posted while it was hidden, so the page asks for the live state
//  ({ ready: true }) when it loads, and the provider also re-posts it when the
//  view is revealed. The VS Code hide/show lifecycle itself can't be driven from
//  the test host, so these tests pin the extension-side contract with a fake
//  WebviewView; the pane-swap itself is a manual check.
// ============================================================================

import * as assert from "assert";
import * as vm from "vm";
import * as vscode from "vscode";
import { BuildOptions } from "../build/buildOptions";
import { describeVsSelection } from "../env/visualStudioPreference";
import { computeIntelliSenseSnapshot } from "../intellisense/intellisenseStatus";
import { DashboardViewProvider } from "../view/dashboardView";
import { memoryMemento } from "./mcpHarness";

// ---- Fixture ---------------------------------------------------------------

interface ConfigRow {
  label: string;
  value?: string;
  cmd?: string;
}

/** The slice of the page state these tests read (the full object is `pageState()`). */
interface PageState {
  running: boolean;
  activity: Record<string, unknown>;
  status: { base: boolean; cpp: boolean; lua: boolean };
  config: { cpp: { title: string; rows: ConfigRow[] }[] };
  deps: unknown;
  collapse: Record<string, boolean>;
}

type Posted = { type: string; state?: PageState };

interface Dashboard {
  options: BuildOptions;
  memento: vscode.Memento;
  posted: Posted[];
  html(): string;
  refreshCalls(): number;
  viewsSet: string[];
  /** Deliver a message from the page to the provider. */
  receive(message: unknown): void;
  /** Flip the view's visibility and fire onDidChangeVisibility. */
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** Resolve a real DashboardViewProvider against a fake view; collaborators are duck-typed fakes. */
function resolveDashboard(): Dashboard {
  const options = new BuildOptions(memoryMemento());
  const memento = memoryMemento();
  const posted: Posted[] = [];
  const viewsSet: string[] = [];
  let refreshCalls = 0;
  let receive: (message: unknown) => void = () => undefined;
  let disposeView: () => void = () => undefined;
  const visibility = new vscode.EventEmitter<void>();

  const event = <T>() => new vscode.EventEmitter<T>().event;
  const runState = { isRunning: false, onDidChange: event<boolean>() };
  const buildState = { activity: {}, onDidChange: event<unknown>() };
  const onboarding = { hasProject: true, onDidChange: event<void>() };
  const deps = {
    readiness: { base: true, cpp: true, lua: true },
    resultMap: {},
    view: "cpp",
    onDidChange: event<void>(),
    refresh: async (): Promise<void> => {
      refreshCalls++;
    },
    setView: async (view: string): Promise<void> => {
      viewsSet.push(view);
    },
  };
  const intellisense = { current: computeIntelliSenseSnapshot("profile"), onDidChange: event<void>() };

  const view = {
    visible: true,
    onDidChangeVisibility: visibility.event,
    onDidDispose: (callback: () => void) => {
      disposeView = callback;
      return { dispose() {} };
    },
    webview: {
      options: {},
      html: "",
      cspSource: "",
      postMessage: (message: Posted) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (callback: (message: unknown) => void) => {
        receive = callback;
        return { dispose() {} };
      },
    },
  };

  const provider = new DashboardViewProvider(
    runState as never,
    buildState as never,
    onboarding as never,
    options,
    deps as never,
    intellisense as never,
    memento,
    vscode.Uri.file(__dirname),
    "test",
  );
  provider.resolveWebviewView(view as unknown as vscode.WebviewView);

  return {
    options,
    memento,
    posted,
    html: () => view.webview.html,
    refreshCalls: () => refreshCalls,
    viewsSet,
    receive: (message) => receive(message),
    setVisible: (visible) => {
      view.visible = visible;
      visibility.fire();
    },
    dispose: () => {
      disposeView();
      visibility.dispose();
    },
  };
}

// ---- Helpers ---------------------------------------------------------------

/** The `state` messages posted so far. */
function stateMessages(dashboard: Dashboard): PageState[] {
  return dashboard.posted.filter((m) => m.type === "state").map((m) => m.state!);
}

/** A C++-section row's displayed value, e.g. ("Build Options", "Config"). */
function rowValue(state: PageState, section: string, label: string): string | undefined {
  return state.config.cpp.find((s) => s.title === section)?.rows.find((r) => r.label === label)?.value;
}

// ---- Tests -----------------------------------------------------------------

suite("Dashboard view (resync after a pane swap, #41)", () => {
  let dashboard: Dashboard;

  setup(() => {
    dashboard = resolveDashboard();
  });

  teardown(() => {
    dashboard.dispose();
  });

  // ---- The page's first paint --------------------------------------------
  test("the page bakes the resolve-time state, then announces ready as its last statement", () => {
    const html = dashboard.html();
    const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    assert.doesNotThrow(() => new vm.Script(script), "the page script is valid JavaScript");
    assert.ok(html.includes('"label":"Config","value":"profile"'), "INITIAL carries the resolve-time config");
    assert.ok(html.includes("applyState(INITIAL);"), "first paint goes through applyState");
    assert.match(html, /vscode\.postMessage\(\{ ready: true \}\);\s*<\/script>/, "ready is the last script statement");
    assert.ok(
      html.lastIndexOf("vscode.postMessage({ ready: true })") > html.indexOf("window.addEventListener('message'"),
      "ready is posted only after the page can receive the reply",
    );
  });

  // ---- The ready handshake ----------------------------------------------
  test("ready posts the CURRENT state, not the resolve-time one", async () => {
    const baked = dashboard.html();
    await dashboard.options.setConfig("debug");
    await dashboard.options.setRunTarget("GameLauncher");
    await dashboard.options.setLaunchArgs("+LoadLevel Test");
    dashboard.posted.length = 0;

    dashboard.receive({ ready: true });

    const states = stateMessages(dashboard);
    assert.strictEqual(states.length, 1, "exactly one state message");
    const state = states[0];
    assert.strictEqual(rowValue(state, "Build Options", "Config"), "debug");
    assert.strictEqual(rowValue(state, "Launch Options", "Run Target"), "GameLauncher");
    assert.match(rowValue(state, "Launch Options", "Launch Options") ?? "", /LoadLevel Test/);
    assert.strictEqual(state.running, false);
    assert.deepStrictEqual(state.activity, {});
    assert.deepStrictEqual(state.status, { base: true, cpp: true, lua: true });
    assert.ok(state.deps, "onboarding model is included");
    assert.strictEqual(dashboard.html(), baked, "the html is set once — which is why the page must ask");
  });

  test("ready reflects a collapse change made after the view resolved", () => {
    dashboard.receive({ ready: true });
    assert.strictEqual(stateMessages(dashboard)[0].collapse.lua, undefined, "nothing stored yet (page applies defaults)");

    dashboard.receive({ collapse: { key: "lua", open: true } });
    dashboard.receive({ collapse: { key: "cpp", open: false } });
    dashboard.posted.length = 0;
    dashboard.receive({ ready: true });

    const state = stateMessages(dashboard)[0];
    assert.strictEqual(state.collapse.lua, true);
    assert.strictEqual(state.collapse.cpp, false);
  });

  // ---- Revealing the view ------------------------------------------------
  test("revealing the view re-posts the current state and re-detects", async () => {
    await dashboard.options.setConfig("release");
    dashboard.posted.length = 0;
    const refreshesBefore = dashboard.refreshCalls();

    dashboard.setVisible(true);

    const states = stateMessages(dashboard);
    assert.strictEqual(states.length, 1);
    assert.strictEqual(rowValue(states[0], "Build Options", "Config"), "release");
    assert.strictEqual(dashboard.refreshCalls(), refreshesBefore + 1, "deps still re-detect on reveal");
  });

  test("hiding the view posts nothing", () => {
    dashboard.posted.length = 0;
    const refreshesBefore = dashboard.refreshCalls();

    dashboard.setVisible(false);

    assert.strictEqual(dashboard.posted.length, 0);
    assert.strictEqual(dashboard.refreshCalls(), refreshesBefore);
  });

  // ---- Existing messages still work --------------------------------------
  test("command, collapse and view messages are still handled; ready runs no command", async () => {
    const dispatched: string[] = [];
    const commands = vscode.commands as unknown as { executeCommand: (id: string) => Thenable<unknown> };
    const original = commands.executeCommand;
    commands.executeCommand = (id: string) => {
      dispatched.push(id);
      return Promise.resolve(undefined);
    };
    try {
      dashboard.receive({ command: "build" });
      dashboard.receive({ command: "notACommand" }); // not in the whitelist
      dashboard.receive({ ready: true });
    } finally {
      commands.executeCommand = original;
    }
    assert.deepStrictEqual(dispatched, ["o3de.build"], "only the whitelisted command ran");

    dashboard.receive({ collapse: { key: "setup", open: true } });
    assert.strictEqual(dashboard.memento.get<Record<string, boolean>>("o3de.dashboard.collapse")?.setup, true);

    dashboard.receive({ view: "lua" });
    assert.deepStrictEqual(dashboard.viewsSet, ["lua"]);
  });

  // ---- The Visual Studio row (#38) ----------------------------------------
  test("Build Options has a Visual Studio row right after Compiler on Windows, and none elsewhere", () => {
    dashboard.receive({ ready: true });
    const rows = stateMessages(dashboard)[0].config.cpp.find((s) => s.title === "Build Options")!.rows;
    const labels = rows.map((r) => r.label);
    if (process.platform !== "win32") {
      assert.ok(!labels.includes("Visual Studio"));
      return;
    }
    assert.strictEqual(labels.indexOf("Visual Studio"), labels.indexOf("Compiler") + 1);
    const row = rows.find((r) => r.label === "Visual Studio")!;
    assert.strictEqual(row.cmd, "selectVisualStudio");
    assert.strictEqual(row.value, describeVsSelection(), "read synchronously, never by running vswhere in a render");
  });

  test("the selectVisualStudio command is whitelisted for the page", () => {
    const dispatched: string[] = [];
    const commands = vscode.commands as unknown as { executeCommand: (id: string) => Thenable<unknown> };
    const original = commands.executeCommand;
    commands.executeCommand = (id: string) => {
      dispatched.push(id);
      return Promise.resolve(undefined);
    };
    try {
      dashboard.receive({ command: "selectVisualStudio" });
    } finally {
      commands.executeCommand = original;
    }
    assert.deepStrictEqual(dispatched, ["o3de.selectVisualStudio"]);
  });
});
