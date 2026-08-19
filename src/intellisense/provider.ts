// ============================================================================
//  Live C++ IntelliSense — cpptools CustomConfigurationProvider (build_launch B.4.3).
//
//  Registers with the C/C++ extension so cpptools ASKS US, per file, for the
//  IntelliSense config (instead of reading the static c_cpp_properties.json).
//  This gives per-target precision and reactive updates: when the File API reply
//  changes (a reconfigure) we rebuild and notify cpptools, no file rewrite.
//  c_cpp_properties.json remains as the fallback when the provider is inactive.
// ============================================================================

import * as vscode from "vscode";
import * as fs from "fs";
import {
  CppToolsApi,
  CustomConfigurationProvider,
  SourceFileConfiguration,
  SourceFileConfigurationItem,
  Version,
  WorkspaceBrowseConfiguration,
  getCppToolsApi,
} from "vscode-cpptools";
import { log } from "../log";
import { readProject } from "../o3de/identity";
import { BuildOptions } from "../build/buildOptions";
import { fileApiReplyDir } from "../build/configureCommand";
import { sourceEngineFolder } from "../build/workspaceFolders";
import { EXTENSION_ID } from "../constants";
import { loadFileApiReply } from "./fileApi";
import { buildProviderModel, ProviderModel } from "./providerModel";
import { intelliSenseModeFor } from "./cppProperties";
import { detectBuildEngineRoot } from "./engineRoot";
import { RootMapping } from "./remap";
import { normalizePath, uniqueStable } from "./paths";

const CODE_SOURCE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|inl|ipp|tpp)$/i;

// Engine build → source engine, as an ABSOLUTE path (provider responses aren't ${var}-resolved).
function buildAbsoluteMappings(
  project: ReturnType<typeof readProject>,
  includePaths: string[],
): RootMapping[] {
  if (!project) {
    return [];
  }
  const source = sourceEngineFolder();
  const buildEngineRoot = detectBuildEngineRoot(project, includePaths);
  if (buildEngineRoot && source) {
    return [
      {
        fromRoot: buildEngineRoot,
        toRef: normalizePath(source.path),
        verifyBase: source.path,
        exists: (absPath) => fs.existsSync(absPath),
      },
    ];
  }
  return [];
}

const EMPTY_CONFIG: SourceFileConfiguration = {
  includePath: [],
  defines: [],
  intelliSenseMode: intelliSenseModeFor(undefined) as SourceFileConfiguration["intelliSenseMode"],
};

// ---- Provider --------------------------------------------------------------
class O3deConfigurationProvider implements CustomConfigurationProvider {
  readonly name = "O3DE Development Tools";
  readonly extensionId = EXTENSION_ID;
  private model: ProviderModel | undefined;

  /** Rebuild the merged model from every workspace project's File API reply. Returns file count. */
  refresh(options: BuildOptions): number {
    const perFile = new Map<string, SourceFileConfiguration>();
    const browsePath: string[] = [];
    let compilerPath: string | undefined;
    let defaultConfig: SourceFileConfiguration | undefined;
    let projects = 0;

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const project = readProject(folder.uri.fsPath);
      if (!project || !fs.existsSync(fileApiReplyDir(project.path))) {
        continue;
      }
      const reply = loadFileApiReply(fileApiReplyDir(project.path), options.config);
      if (!reply || reply.targets.length === 0) {
        continue;
      }
      const includePaths = reply.targets.flatMap((t) => t.compile.includes.map((i) => i.path));
      const model = buildProviderModel(reply, project.path, buildAbsoluteMappings(project, includePaths));
      for (const [key, value] of model.perFile) {
        perFile.set(key, value);
      }
      browsePath.push(...model.browsePath);
      compilerPath ??= model.compilerPath;
      defaultConfig = model.defaultConfig;
      projects += 1;
    }

    this.model =
      projects > 0
        ? { perFile, defaultConfig: defaultConfig ?? EMPTY_CONFIG, browsePath: uniqueStable(browsePath), compilerPath }
        : undefined;
    return this.model ? this.model.perFile.size : 0;
  }

  canProvideConfiguration(uri: vscode.Uri): Thenable<boolean> {
    return Promise.resolve(!!this.model && CODE_SOURCE.test(uri.fsPath));
  }

  provideConfigurations(uris: vscode.Uri[]): Thenable<SourceFileConfigurationItem[]> {
    if (!this.model) {
      return Promise.resolve([]);
    }
    const model = this.model;
    return Promise.resolve(
      uris.map((uri) => ({
        uri,
        // per-target config when it's one of the project's own files; else the consolidated union.
        configuration: model.perFile.get(normalizePath(uri.fsPath).toLowerCase()) ?? model.defaultConfig,
      })),
    );
  }

  canProvideBrowseConfiguration(): Thenable<boolean> {
    return Promise.resolve(!!this.model);
  }

  provideBrowseConfiguration(): Thenable<WorkspaceBrowseConfiguration | null> {
    if (!this.model) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      browsePath: this.model.browsePath,
      compilerPath: this.model.compilerPath,
      standard: this.model.defaultConfig.standard,
    });
  }

  canProvideBrowseConfigurationsPerFolder(): Thenable<boolean> {
    return Promise.resolve(false);
  }

  provideFolderBrowseConfiguration(): Thenable<WorkspaceBrowseConfiguration | null> {
    return this.provideBrowseConfiguration();
  }

  dispose(): void {
    this.model = undefined;
  }
}

// ---- Registration + reactivity ---------------------------------------------
export async function registerConfigurationProvider(
  context: vscode.ExtensionContext,
  buildOptions: BuildOptions,
): Promise<void> {
  const provider = new O3deConfigurationProvider();
  context.subscriptions.push(provider);
  log().info(`IntelliSense provider: indexed ${provider.refresh(buildOptions)} project source file(s).`);

  let api: CppToolsApi | undefined;
  try {
    api = await getCppToolsApi(Version.latest);
  } catch (err) {
    log().warn(`cpptools API error: ${String(err)}`);
  }
  if (!api) {
    log().warn(
      "C/C++ extension (ms-vscode.cpptools) not available — live provider not registered; " +
        "c_cpp_properties.json still applies.",
    );
    return;
  }
  api.registerCustomConfigurationProvider(provider);
  api.notifyReady(provider);
  context.subscriptions.push(api);
  log().info("IntelliSense provider registered with cpptools (live, per-target).");

  // Coalesce refresh triggers (config switch, reconfigure) to avoid event storms.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      const count = provider.refresh(buildOptions);
      api.didChangeCustomConfiguration(provider);
      api.didChangeCustomBrowseConfiguration(provider);
      log().info(`IntelliSense provider refreshed (${count} file(s)) → cpptools re-queried.`);
    }, 500);
  };

  context.subscriptions.push(buildOptions.onDidChange(() => notify()));

  // Reconfigure writes a fresh File API reply index — watch for it per workspace project.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (!readProject(folder.uri.fsPath)) {
      continue;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "build/*/.cmake/api/v1/reply/index-*.json"),
    );
    watcher.onDidChange(notify);
    watcher.onDidCreate(notify);
    context.subscriptions.push(watcher);
  }
}
