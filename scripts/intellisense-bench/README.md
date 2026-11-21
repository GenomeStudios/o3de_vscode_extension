# IntelliSense benchmark

Measures how well clangd serves an O3DE workspace, given a compile database.
It answers three questions, each one a stage you can run on its own:

| Stage | Question | How |
| --- | --- | --- |
| `coverage` | Which on-disk `.cpp` files have a compile-DB entry at all? A file without an entry gets guessed flags and poor IntelliSense. | Counts `.cpp/.cxx/.cc` under each part's folders (skipping `excludeDirs`) and checks them against the DB. |
| `check` | Does clangd parse a sample of files without errors? | `clangd --check=<file>` per file, a few at a time, with a timeout. |
| `nav` | Does F12 (go to definition), Ctrl+T (workspace symbol) and the relationship requests (find references, implementation, type hierarchy, call hierarchy, rename, code actions, completion) answer correctly, once the background index is built? | Starts a real clangd with the extension's flags, waits for the index, then asks LSP the same questions the editor would. |

Node built-ins only. Nothing to install.

## Run it

```
node bench.mjs --recipe <recipe.json> [--variant <name>] [--only coverage|check|nav] [--cold] [--out <dir>] [--clangd <path>]
node bench.mjs --selftest [--work-dir <dir>] [--clangd <path>]
node --test
```

- `--variant` / `--only` can be repeated or comma-separated.
- `--cold` deletes each variant's background index first, so `nav` times the index from scratch. Without it the existing index is reused (a warm run). The report says which it was.
- `--out` sets the run folder; it must be inside the recipe's `workDir`.
- `--selftest` builds a tiny scratch C++ project in `<work-dir>/selftest` (default `D:/ib`), runs the whole pipeline cold then warm, and asserts the results (see "Self-test"). Exit code 0 only when every assertion passes.
- `node --test` (run in this folder) runs the unit tests. They do not start clangd, except for a fake LSP server made from `node` itself.

Exit codes: 0 = ran, 1 = a stage failed or the selftest failed, 2 = bad usage. A benchmark with failing probes still exits 0: it is a measurement, not a gate.

Each run writes `<workDir>/runs/<UTC timestamp>-<recipe>-<variant>/report.md` and `report.json` (`all` replaces the variant name when several ran). In `report.json` (schema 2) `nav.probes` holds the F12 probes only; the other probe types are under `nav.relationships`, per kind under `nav.capabilities`, and the path-identity numbers under `nav.symbols.pathIdentity`.

## Recipe

One JSON file (`//` and `/* */` comments are allowed). Paths must be absolute.

```jsonc
{
  "name": "gs_play",                  // file-name safe
  "clangd": "<path to clangd.exe>",
  "workDir": "D:/ib",                 // EVERYTHING the harness writes goes under here
  "project": "D:/OffLocalDev/gs_play",
  "parts": {                          // ordered: the first matching folder prefix wins
    "projectGem":    ["<abs folder>"],
    "project":       ["D:/OffLocalDev/gs_play"],
    "workspaceGems": ["D:/OffLocalDev/gs_play_gems"],
    "engineSource":  ["d:/OffLocalDev/o3de_sourcedev"],
    "engineSdk":     ["C:/Users/<you>/.o3de/Engines/GS_Play_Engine"]
  },
  "excludeDirs": ["/build/", "/.cache/", "/Cache/", "/3rdParty/", "/External/"],   // coverage scan only
  "variants": [
    { "name": "A-extension", "db": "<abs path to a compile_commands.json>", "extraArgs": ["--header-insertion=never"] }
  ],
  "sample": { "perPart": 8, "extraFiles": ["<abs path, e.g. a header that is not in the DB>"] },
  "probes": [
    {                                     // no "type" = an F12 (go to definition) probe
      "id": "gem-to-azcore-entity-cpp", "part": "workspaceGems", "category": "gem->engine .cpp",
      "file": "<abs path>", "anchor": "<substring unique in the file, on the probe line>",
      "token": "<identifier on that line to F12 on>",
      "expect": { "fileSuffix": "AzCore/Component/Entity.cpp", "kind": "definition" },
      "expectedBuilt": true
    },
    {                                     // the other kinds of question, see "Probe types"
      "id": "bus-handlers", "type": "implementation", "part": "workspaceGems", "category": "bus -> handlers",
      "file": "<abs path>", "anchor": "virtual void OnSpawn() = 0;", "token": "OnSpawn",
      "expect": { "mustIncludeFileSuffixes": ["Source/SpawnHandler.cpp"] }
    }
  ],
  "symbols": [ { "query": "AZ::Entity", "expectFileSuffix": "AzCore/Component/Entity.h" } ],
  "nav": { "dbSubset": { "neighbours": 2 } },   // optional: index a reduced DB so the index can finish (see below)
  "limits": { "checkTimeoutSec": 180, "checkConcurrency": 3, "indexWaitMin": 30, "jobs": 4, "diagnosticsWaitSec": 60 }
}
```

Details that are easy to miss:

- **Parts.** Every file is classified into the first part whose folder is a prefix of it (case-insensitive, slashes normalised); anything else is `other`. List a more specific folder before a general one (`projectGem` before `project`).
- **Variants.** Each variant is one compile database to compare. `extraArgs` are extra clangd command-line arguments for that variant (they must not set `--compile-commands-dir`).
- **Sample.** Per part, the DB's distinct files are sorted by path and `perPart` evenly spaced ones are taken, so the same DB always gives the same sample. `extraFiles` are checked too; they need not be in the DB, which is how you measure headers (clangd infers a command from a neighbouring file). The sample is drawn **once per run, from every variant's DB together** (all of the recipe's variants, even when `--variant` picks one), so every variant is checked on the same files. A file a variant's DB has no entry for is still checked, with a command clangd infers, exactly as the editor would; the report splits the clean percentage by this (see "Reading the report").
- **Probes.** `anchor` must occur exactly once in the file; its line is the probe line. `token` is matched on that line, first match (add `"occurrence": 1` for the second); an identifier matches as a whole word, a punctuation token such as `->`, `::` or `.` matches as it is. The position is the start of the token, in UTF-16 columns. `"afterToken": true` (completion probes only) puts the cursor just after the token instead.
- **Pass rule (F12 probes, no `type`).** A probe passes when any returned location is in a file whose path ends with `expect.fileSuffix` (case-insensitive, on a path-segment boundary).
  - `kind: "definition"`: `textDocument/definition` must land there.
  - `kind: "any"`: `textDocument/definition` or, failing that, `textDocument/declaration` may land there (use it when a header declaration is an acceptable answer).
  - LSP results do not say whether a location is a declaration or a definition, so the suffix is what pins it down: to demand the implementation, name the `.cpp`.
- **`expectedBuilt: false`** marks a probe whose gem is not part of this project's build. It is still run, but reported separately and left out of the headline pass rate.

### Probe types

A probe's optional `"type"` says which LSP question is asked at the token. The default, `"definition"`, is the F12 probe above. Every other type is a **relationship** probe: it asks across files, so it needs the background index (`needsIndex`), is skipped with "index incomplete" when the index did not finish, and is reported in the Capabilities and Relationships tables rather than in the F12 numbers. "Suffix" always means the path-segment suffix match described above; a file that comes back under two path spellings (`D:/x` and `d:/x`, which clangd does) counts once.

| `type` | LSP requests | `expect` | Passes when |
| --- | --- | --- | --- |
| `references` | `textDocument/references`, `includeDeclaration: false` | `mustIncludeFileSuffixes: [..]`, `minFiles?: n` (one of the two is required) | every suffix is among the result files and there are at least `minFiles` distinct files |
| `implementation` | `textDocument/implementation` (e.g. a virtual or a bus event) | `mustIncludeFileSuffixes: [..]` | every suffix is among the result files |
| `typeHierarchy` | `textDocument/prepareTypeHierarchy`, then `typeHierarchy/subtypes` for the class at the token, then `subtypes` again for each first-level subtype (the first 10) | `subtypeFileSuffixes: [..]` | every suffix is among the files of the subtypes of either level |
| `incomingCalls` | `textDocument/prepareCallHierarchy`, then `callHierarchy/incomingCalls` | `mustIncludeFileSuffixes: [..]` | every suffix is among the callers' files |
| `rename` | `textDocument/prepareRename`, then `textDocument/rename` to `<token>_BenchRename` | `minFiles: n`, `mustIncludeFileSuffixes?: [..]` | the edit touches at least `minFiles` distinct files, including every suffix. **The `WorkspaceEdit` is only counted, never applied**: edit and file counts are recorded, nothing is written, and the self-test proves no file changes |
| `codeAction` | `textDocument/codeAction` over the token's range, `context.diagnostics` = what clangd published for the file, no `only` | `titleIncludes: "<text>"` | some action's title contains the text (case-insensitive) |
| `completion` | `textDocument/completion` at the position (use `afterToken` after `->`, `.` or `::`) | `labelsInclude: [..]` | every name is among the items (exact, case-sensitive, compared on the identifier that would be inserted) |

- A clangd **error reply** ("cannot rename symbol here", the `--rename-file-limit`, ...) is an answer: the probe `fail`s with clangd's message. A timeout or a dead server is `error` (could not run).
- With `nav.dbSubset`, only the files the subset holds are indexed. Every suffix named in `mustIncludeFileSuffixes` / `subtypeFileSuffixes` is kept in the subset (a `.cpp` by suffix, a header through its same-name source), but `minFiles` can only count files that were indexed: keep it within what the subset can reach.
- Real clangd 22.1.6 answers to know when writing `expect` (all measured, see the self-test project):
  - `references` on a virtual method lists the call sites only, not the overriding declarations; on a class name it lists every use, including the `Creature::` qualifier of a method definition in the `.cpp`. The same location can appear twice under the `D:/` and `d:/` spellings.
  - `implementation` on a pure virtual answers with the overriding **definitions** (`Dog::Sound` in `dog.cpp`), not the declarations in the derived headers. **Order matters, though:** clangd's dynamic index keeps the declaration-only symbols of every file opened earlier in the session (closing a file does not drop them), and for `implementation` those shadow the `.cpp` definition. So an overrider whose header is included by an earlier probe file can come back as the header declaration instead of its `.cpp` (measured with `AZ::Component::Activate`: the same probe passed alone and failed after 22 earlier probes). Name overriders whose `.cpp` comes back as a definition in recipe order, and re-check them when probes are added in front.
  - Completion labels are decorated (`" Size() const"`, `"•Dog"` with a bullet when picking it would add an include), so the harness compares the item's `filterText`.
  - `rename` can name one file twice, as `file:///D:/..` and `file:///d:/..`. The report counts distinct files and notes the extra spellings.
  - Code action titles seen at assorted tokens (the title is what `titleIncludes` matches): **`Override pure virtual methods`** (a class that derives from an abstract class and overrides nothing; clangd's "override" action), `Declare implicit copy/move members`, `Extract subexpression to variable`, `Move function body to declaration`, `Swap operands to *`, `Add using-declaration for Widget and remove qualifier`.
- **Symbols.** `workspace/symbol` (the Ctrl+T box). Passes when any result is in a file ending with `expectFileSuffix`. clangd returns at most 100 results by default, as it does for editor users.
- **`nav.dbSubset`.** Optional. `true`, or `{ "neighbours": n }` (default 2). The nav stage then points clangd at a reduced copy of the DB, `variants/<name>/nav-subset/`, so its background index finishes in minutes instead of hours. The subset holds every entry for a probe file, every entry for a `.cpp` a probe or symbol should land in (suffix match), the sources with the same file name stem as an expected header (`Foo.h` -> `Foo.cpp`), every entry for each **proxy file** (below), and up to `neighbours` more entries from the folder of each of those (sorted by path). A header-only target is found because some chosen file includes it. The **check stage always uses the full DB**.
- **Probe files without an entry (headers, unbuilt gems, legacy files).** clangd opens such a file with flags it infers from another entry of the DB, chosen by how close the paths and names are, so the answer depends on every entry the DB holds. A reduced DB must not change it, and the harness does not copy clangd's ranking: before the nav stage it runs `clangd --check=<file> --compile-commands-dir=<the full DB copy>` for each probe file that has no entry (any extension), reads the line `Compile command inferred from <file> is: ...` (see "What `clangd --check` prints"; the run is stopped as soon as the line is printed, about a second a file) and keeps every entry of that **proxy file** in the subset. clangd scores each candidate on its own, so the full DB's winner is still the winner in a subset that holds it, and the probe file gets the same flags as in the full DB; no neighbour cap is needed. If clangd names no entry (or one the DB does not hold) the harness logs a `WARNING` and falls back to the old behaviour: the file is labelled **`subset-inferred`**, its flags are whatever the subset offers, and its numbers are not comparable with a full-DB run. Without `nav.dbSubset` the flags are the full DB's by construction (label `full-DB inferred`; the proxy is still looked up and reported). The report lists the files, the label and the proxy ("Probe files without a compile-DB entry"), and every probe table has a `Flags` column. Leave `nav` out (or `false`) to index the full DB, which is how you measure index time; the report says "Compile DB: full" or "SUBSET: n of m entries", and nav numbers from a subset run and a full run are not comparable.
- **Limits.** `indexWaitMin` caps the wait for the background index. If it is hit, the run continues, but the report says **INDEX INCOMPLETE - partial results** and the nav stage skips what depends on the index (see "Reading the report"). With the full gs_play DB the cap must be 150 minutes or more, so the shipped recipe sets `indexWaitMin: 150` and `jobs: 12`, and uses `nav.dbSubset`.

## Reading the report

- **Header.** Recipe hash (sha256 of the recipe text plus every variant's DB bytes: same hash, same inputs), clangd version, whether the run was `--cold`, timestamps.
- **Coverage.** Per part: files on disk, how many have an entry, percentage. "DB-only files" are DB entries that the disk scan did not find (generated sources, or files in excluded folders). Low coverage in a part means most of its files get fallback flags.
- **Check.** "Clean" means the file parses with no compile error. Per part: percent clean. "Top error messages" ranks distinct messages by how many files hit them, which usually points at one missing include path or define.
  - Status `ok`: clangd finished and printed no compile error.
  - Status `ok-slow` (counted clean, listed in its own note): the run hit the timeout AFTER "Indexing AST..." with no compile error printed. clangd prints every compile diagnostic before that line, so the file is known to parse; only the per-token feature pass was slow (a large gtest file took over 100 s), and how slow depends on CPU load and `checkConcurrency`, not on the file. The same timeout WITH a compile error already printed is `errors`.
  - Status `timeout`: no AST was built before the timeout, so nothing is known about the file. Not clean. `failed` and `errors` are not clean either.
  - The table splits files by where their compile command came from: **in every variant's DB** (the fair number to compare variants on), in this variant's DB, and **inferred** by clangd (no entry in this DB: headers, and files only another variant builds). Inferred-command files are a separate line because the inference depends on the DB.
- **Navigation.**
  - Index start state (cold or warm), whether the compile DB was full or a subset, time to the index "end" event, index size on disk, folder.
  - **Probe files without a compile-DB entry.** One row per such file: `full-DB inferred` (the flags are the ones the full DB gives) or `subset-inferred` (clangd did not name the entry, so the flags depend on the subset), and the entry the flags are inferred from. The probe tables carry the same label in their `Flags` column; `report.json` has it as `nav.entryless` and per probe as `flags: {source, from}`.
  - **F12 probes** (no `type`): pass rate per part and per category, then each failing probe with where F12 actually landed. Probes are also split into **independent of the index** and **needing the index** (the target is another `.cpp`, which clangd only finds through the background index), each with its own rate; the report counts how many probes needed the index.
  - **Capabilities.** One row per kind of question asked of clangd (go to definition, find references, implementation, type hierarchy, call hierarchy, rename, code actions, completion, workspace symbol): pass / total of the probes that ran, built projects only. Only kinds that have probes get a row.
  - **Relationships.** The headline over every relationship probe (built projects only), a breakdown by `category` (with the types in it), each failing probe with what it expected and **what came back** (counts, then the first 8 files and names), and a collapsed list of every relationship probe with its counts. A rename row shows `edits` and `files` (and `uris` when a file came back under two path spellings). Skipped and not-built probes are counted apart, as for F12.
  - Symbol pass rate.
  - **Path identity** (under the symbol table). The number of symbol results where the same name and container comes back from two different files whose paths end the same under different roots (at least the last 3 segments in common, e.g. the SDK copy and the surrogate copy of `AzCore/Component/Entity.h`), with examples. It reads every result of every symbol query that ran (up to clangd's 100), not only the first hit. 0 means no duplicate roots showed up in those queries; a non-zero count means F12 or Ctrl+T can land in the copy that is not the one being edited.
  - **INDEX INCOMPLETE - partial results.** When the index did not finish within `indexWaitMin`, the probes that need the index (F12 onto another `.cpp`, and every relationship probe) and ALL symbol queries (a header symbol needs some indexed file that includes it) are recorded as `skipped: index incomplete`. They are left out of every rate and out of the failed list, because whether they pass would only measure how far the index got. The banner is on the probe and symbol headline lines, and `bench.mjs` prints a WARNING at the end of the run. Probes that do not need the index still run, but against a moving index, so their timings carry noise.
  - With two or more variants, the report refuses the comparison ("Navigation comparison between variants: REFUSED") unless every variant's index finished.
  - Compare warm/cold numbers only with the same state; say which one you quote.
- **Header table.** "Work dir lock" says the run held `<workDir>/.bench.lock`, so no other harness run was using the folder. "Other clangd processes at start" counts clangd processes already running (an editor's, say): they share the CPU, so timings from a run with some are less clean.

## What `clangd --check` prints (clangd 22.1.6, Windows)

Measured by running it on real files; the parser (`lib/clangdCheck.mjs`) and its fixtures (`test/fixtures/check-*.txt`) follow this.

- Everything goes to **stderr**; stdout is empty. Lines look like `I[04:16:12.563] message` (`I` info, `E` error).
- Compile error: `E[..] [pp_file_not_found] Line 1: 'nothere.h' file not found`.
- Noise that is not a compile error: `E[..]     tweak: SpecialMembers ==> FAIL: ...` (code-action probes; the reason can wrap onto following unprefixed lines) and `E[..] IncludeCleaner: Failed to get an entry ...`. Also noise, not counted in N: `E[..] Failed to resolve URI : Scheme must be provided in URI:` (the per-token feature tests; two dozen lines on a header that parses cleanly).
- `I[..] Indexing AST...` appears once the AST is built, after every compile diagnostic. After it clangd tests its features at every token, which is where the time goes on a big file. A timeout after this line with no compile error is `ok-slow` (clean).
- Last line: `I[..] All checks completed, N errors`. N counts compile errors **and tweak failures**, not IncludeCleaner lines. A header with no compile errors can still say "5 errors" because of tweak failures, so the harness counts compile errors itself and treats a surplus in N it cannot explain as an error.
- Warnings are not printed.
- A file that is not in the DB works: `I[..] Compile command inferred from <other file> is: [<directory>] <command>`, right after `Loaded compilation database` and before `Parsing command...`. `<other file>` is the DB entry's file as the DB spells it (`D:/dir/File.cpp`), and it can sit in a different tree than the file (a `gs_ai` file borrows from the `VolumetricCloudsForO3DE` gem). A file that has an entry logs `Compile command from CDB is: ...` instead. `lib/clangdCheck.mjs` `findInferredProxy` reads that line and stops clangd at once.
- A file that does not exist: `E[..] Failed to resolve path ...`, no "All checks completed", exit code 1. The exit code is 0 when clean and 3 whenever any counted error was printed (compile error or tweak failure), so it cannot tell the two apart and the harness does not rely on it.

## Isolation: what the harness touches

- **Reads:** the recipe, each variant's original compile DB, the project/engine/gem files (to scan, sample, open and check), and the clangd binary. clangd itself also reads any `.clangd` / user config the real extension would, so results match what users see.
- **Writes, all under `workDir`:**
  - `variants/<name>/compile_commands.json`, a **copy** of the variant's DB (the original is never modified; the copy is skipped when already identical so a warm index is not disturbed).
  - `variants/<name>/.cache/clangd/index/`, clangd's background index. This is where clangd 22.1.6 puts it: in `.cache/clangd/index` next to the `compile_commands.json` it was pointed at via `--compile-commands-dir` (one `*.idx` shard per file; confirmed by the self-test, which asserts the folder exists and nothing appears next to the original DB or inside the project).
  - With `nav.dbSubset`: `variants/<name>/nav-subset/compile_commands.json` (the reduced DB) and its own `.cache/` index, apart from the full DB's.
  - `tmp/`, clangd's temporary files (`TEMP`/`TMP` are redirected for every clangd the harness starts).
  - `runs/<timestamp>-<recipe>-<variant>/`, the reports.
  - `.bench.lock`, the run lock (see below).
- **Deletes:** `--cold` removes only `variants/<name>/.cache` (or `variants/<name>/nav-subset/.cache` for a subset run), after asserting the path is inside `workDir/variants` and is named `.cache`.
- **One run per work directory.** A run with a `check` or `nav` stage takes `<workDir>/.bench.lock` before it creates or touches anything, and gives it back when it ends (also on errors and Ctrl+C). Without this, `--cold` would delete `.cache` under another run's live clangd, two clangds would write one index, and both would share `tmp/` and skew each other's timings. A second run on the same work directory is refused with "workDir ... is in use by bench pid N (started T, recipe R)". The lock file holds the owner's pid; a lock whose pid is no longer running (a crashed or killed run) is cleared automatically, a lock that cannot be read is treated as live (delete it by hand), and a reused pid after a hard kill can look live (delete it by hand too). A coverage-only run needs no lock. The lock cannot see processes outside the harness, such as an editor's clangd; the report counts those at the start.
- Every write or delete target is checked to be inside `workDir` first (`assertInside`); `--out` outside it is refused.
- Every clangd child is tracked and killed on exit, errors and Ctrl+C.
- The harness never builds, configures or edits the project, the gems, the engine or the SDK, and writes no git state.

## How the nav stage drives clangd

- Before clangd starts, each probe file with no compile-DB entry is looked up on the full DB (see `nav.dbSubset`), and the subset keeps the entry its flags come from. That step runs `clangd --check` briefly per file and writes nothing.
- Flags: `--compile-commands-dir=<variant folder> --background-index --background-index-priority=low -j=<jobs> --log=error` plus the variant's `extraArgs`.
- `initialize` advertises `window.workDoneProgress`; clangd then reports `$/progress` with the token `backgroundIndexProgress` (`"2/2367 0%"` style messages). The wait ends one progress `end` plus 2 s of quiet later.
- `initialize` also advertises what the probes need, as an editor does: `definition` / `declaration` / `implementation` with `linkSupport`, `references`, `typeHierarchy`, `callHierarchy`, `rename.prepareSupport`, `codeAction.codeActionLiteralSupport` (the usual kinds) and `completion.completionItem.snippetSupport: false`. The `CLIENT_CAPABILITIES` constant in `lib/nav.mjs` is the list.
- **clangd does not start the background index until a file is opened** (measured: with no `didOpen`, no progress is reported and no index folder appears). The harness therefore opens the first probe's file (or the first DB file) right after `initialized`, then waits.
- If clangd reports no progress at all for 30 s, the wait ends with a note ("index already up to date, or nothing to index"). That is also what happens with `--background-index=false`.
- Per probe: `didOpen` (a file stays open until a probe needs a different one, so probes in one file share a parse), wait for `publishDiagnostics` (up to `diagnosticsWaitSec`), the probe type's request (`textDocument/definition` by default, see "Probe types"), compare. The diagnostics clangd last published for the file are recorded with the probe (error count and first messages), which usually explains a failure ("file not found" means the DB has no usable entry).

## Self-test

`node bench.mjs --selftest` writes a small C++ project under `<work-dir>/selftest` (6 `.cpp` files and their headers, no standard-library includes, hand-written DB) and runs the real pipeline twice. The project is `main.cpp` / `shape.cpp` / `shape.h` (a function, a class) plus a base class `Creature` (a virtual `Legs`, a pure virtual `Sound`), `Dog` and `Bird` in files of their own, `Puppy` (a subtype of `Dog`, in a third header), and `zoo.cpp` with a caller of `Legs`, an abstract `Lazy` class that overrides nothing, and `CountLegs` / `TotalLegs`. It asserts:

- F12 across files lands in the `.cpp` through the background index, and in the header for a type;
- a deliberately wrong probe **fails** (so a pass means something);
- `workspace/symbol` finds a header symbol and a symbol that exists only in a `.cpp`, and the path-identity metric runs (0 pairs: one root);
- every relationship probe passes end to end: references (a virtual call site; a class used in 5 files), implementation of a pure virtual (the two overriding definitions), type hierarchy at two levels (`Dog`, `Bird`, `Lazy`, then `Puppy`), incoming calls, a rename dry run (4 edits in 3 files, **and no file in the project changed**), clangd's **`Override pure virtual methods`** code action on `Lazy`, and completion after `.` and `::`;
- two negative controls (a references probe and a completion probe with an expectation that cannot hold) **fail**, not error, so the file judge and the name judge both fail when they should;
- the Capabilities rows add up per type (for example references 2/3, completion 2/3, definition 4/5);
- `clangd --check` is clean for all six `.cpp` files and the header (which is not in the DB), and coverage is 6 of 6;
- the index folder exists inside the work dir, has content, was reported through an index progress token, and finished;
- no `.cache` appeared inside the project or next to the original DB;
- the second run sees a warm index and the same results;
- the check rows tell the files with a DB entry from the inferred header, the F12 probes that need the index are counted (3 of 5), every relationship probe needs it, nothing is skipped when the index finishes, and the run lock is given back.

Without the background index the same project fails the cross-file probes (F12 lands on the header) and the `.cpp`-only symbol is not found, so the test is sensitive to the thing it measures. Measured with `--background-index=false` as the variant's `extraArgs`: the references, implementation, type hierarchy and rename probes fail too, while code action, completion and (here, because `main.cpp` had been opened) incoming calls still pass. Code action and completion often need only the open file; they are marked as needing the index anyway, so a half-built index never mixes into the rates.

## Realistic expectations

A full background index of a project the size of gs_play is slow. Measured with `-j=2` on the gs_play DB (2366 files): 12 files in 45 s; with `-j=4`, 497 files in 18 minutes (about 0.46 files/s), so roughly an hour and a half for the whole DB. The default `indexWaitMin: 30` would end with "index NOT finished" for such a DB, and the nav numbers would then be partial (probes and symbols that need the index are skipped, see "Reading the report").

Two ways to get a finished index, both used by the shipped `recipes/gs_play.json`:

- **`nav.dbSubset`** (what the shipped recipe does): index only the entries the probes and symbols need, about 100 to 200 files, which takes minutes (185 entries: about 5 minutes cold at `-j=4`, with another clangd running). The nav numbers are then real; the index time is the subset's, not the full DB's.
- **A full-DB run**: leave `nav` out, set `indexWaitMin` to 150 or more and raise `jobs` towards your core count. Use it to measure index time, and keep it apart from the subset numbers.

## The shipped gs_play probes

`recipes/gs_play.json` holds 136 probes in recipe order: the original 64 F12 probes, then three groups added after them (each has its own comment header in the file).

| Group | Probes | What it asks | On today's compile DB |
| --- | --- | --- | --- |
| Fix-proving, `gem->engine gem .cpp` | 19 F12 | gem code calling into engine gems (EMotionFX, Atom, SurfaceData, ImGui) whose `.cpp` has no DB entry | **Expected to fail** (19/19): F12 lands on the header declaration. They pass once engine-gem sources are covered. |
| Entry-less, `legacy file` / `unbuilt gem` | 15 F12, `expectedBuilt: false` | files with no entry of their own (legacy gs_graphcanvas, gs_ui hub, gs_ai / gs_world stubs) | Their flags are inferred by clangd from another entry; the nav stage asks clangd which one, on the full DB, and keeps it in the subset, so the numbers are the full DB's (report label `full-DB inferred`). Measured on the full DB: **6 of the 15 pass** (`legacy-graphcontroller-ctor-to-own-header`, `legacy-variabletablemodel-to-graphvariable`, `legacy-uihub-to-own-hubbus`, `legacy-cinematics-sequenceasset-to-own-header`, `ai-unbuilt-moduleinterface-to-own-header`, `world-unbuilt-editor-component-to-engine-editorevents`); the other 9 fail. The failure explanations that name `QStringList` and `LyShine` (include dirs missing from the flags clangd borrowed) hold for the **subset-inferred** flags of runs made before the proxy was kept, where 3 of the 15 passed; do not compare those runs with full-DB inferred ones. Reported apart from the headline rate. |
| Relationships | 38 (references 7, implementation 6, type hierarchy 6, incoming calls 4, rename 5, code action 5, completion 5) | cross-gem questions that need the index | all 38 pass with the subset index |

Notes for editing these probes:

- A relationship probe's `minFiles` counts only files the `nav.dbSubset` indexed. `refs-reportready-across-brains` and `refs-lmbrcentral-tagrequests-across-gems` therefore name more `.cpp` files than the thresholds strictly need: naming a `.cpp` is what puts it in the subset.
- The two type-hierarchy probes that go two levels list their second-level targets in `subtypeFileSuffixes` too, because the judge reads both levels together.
- Completion probes put the cursor after the token (`afterToken`, with `occurrence` picking which `::` or `->` on the line); code action probes sit on a class that leaves a pure virtual unimplemented (`Override pure virtual methods`) or on an `auto` (`Replace with deduced type`).
- The rename probes are a dry run: nothing in the gems is written.

## Layout

```
bench.mjs            CLI
lib/recipe.mjs       load + validate the recipe, recipe hash
lib/paths.mjs        path normalising, file URI <-> path
lib/compdb.mjs       compile DB, part classification, on-disk coverage, shared check sample, nav subset (and its proxy files)
lib/clangdCheck.mjs  clangd --check runner and output parser; findInferredProxy (which entry an entry-less file's flags come from)
lib/lsp.mjs          minimal LSP client (byte-length framing)
lib/nav.mjs          clangd session, index wait, probe runner (F12 here), Ctrl+T queries, isolation helpers
lib/probeTypes.mjs   the relationship probe types: the request flow and judge of each, in one table
lib/lspResults.mjs   LSP responses -> plain rows, the judges, evidence, and the path-identity metric (pure functions)
lib/report.mjs       aggregation (F12, capabilities, relationships, symbols), report.json, report.md
lib/run.mjs          runs the stages for the chosen variants, under the work dir lock
lib/lock.mjs         the <workDir>/.bench.lock run lock
lib/procs.mjs        tracked child processes, clangd discovery, clangd process count
lib/selftest.mjs     the --selftest scratch project and assertions
test/*.test.mjs      node --test unit tests; test/fixtures holds real clangd --check output and
                     lsp-responses.json, real clangd 22.1.6 answers for every relationship request
```
