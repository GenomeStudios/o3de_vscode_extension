# O3DE Development Tools — project instructions

## Changelog: use the version placeholder — never hardcode a version

When adding release notes, put them at the TOP of `changelog.md` under a
**placeholder** header (not a real version number):

```markdown
## [pending_version] — YYYY-MM-DD

### Added
- ...
### Changed
- ...
### Fixed
- ...
```

Rules:
- Keep exactly **one** `[pending_version]` section (the unreleased set). Add new
  entries under it (Added / Changed / Fixed).
- **Never invent or bump a version number in the changelog.** At publish time
  `publish.bat` runs `scripts/stamp-changelog.js <version>`, which rewrites the
  `## [pending_version] — …` line to `## [<decided version>] — <today>` (em-dash
  U+2014, ISO date). No placeholder present → it's a no-op.

## Version = single source of truth (`package.json`)

`package.json` `version` is the ONLY place the extension version is set — bumped by
`npm version` inside `publish.bat`, or by hand. Everything else derives from it:
the dashboard footer reads `context.extension.packageJSON.version` at runtime, and
the Marketplace / `.vsix` use `package.json`. **Do not hardcode the extension
version anywhere in `src/`.**

- Exception: `src/build/launchConfig.ts`'s `version: "0.2.0"` is the **launch.json
  schema** version (VS Code's debug-config format), NOT the extension version — leave it.

## Release flow

`publish.bat` (Windows): clean-tree check → confirm → bump menu (**P** patch /
**N** minor / **M** major / **S** skip = publish current version as-is) → stamp
changelog → package one `.vsix` → publish to VS Code Marketplace + Open VSX. Full
details in `PUBLISHING.md`.

## MCP parity: every feature gets MCP equivalents

Every feature we build (and every feature already shipped as we touch it) needs an
MCP equivalent on the extension's LLM/MCP endpoint (`src/mcp/serverImpl.ts`), so an
assistant can read its status and drive it on demand — not only a human through the
dashboard.

- **Status** a feature shows (dashboard rows, onboarding rows) → a read-only tool
  (`readOnlyHint`), returning the same answers from the same code.
- **Actions** a feature offers (switches, generators, remedies) → a tool that runs the
  same core HEADLESS: no prompts or notifications; the outcome (including anything the
  user must still do, e.g. a window reload) comes back as structured data.
- Pattern: pure rules → a vscode-side headless core → a thin `*Query.ts` module
  (like `build/configQuery.ts`, `intellisense/intellisenseQuery.ts`) → tool registration.
  The dashboard/command path wraps the same core with its UI.
- Tools never install extensions or do destructive work unless the user opted in
  (see `o3de_force_close`'s gate).
- Each plan stage declares its MCP tools next to its "Done when" criteria, and the
  tools get tests (end-to-end through the SDK client: `src/test/mcpIntelliSense.test.ts`).
