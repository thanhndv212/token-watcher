# UA-TW-07 GUI session views, packaging and documentation

Issue: [#74](https://github.com/thanhndv212/token-watcher/issues/74) (epic [#67](https://github.com/thanhndv212/token-watcher/issues/67)). Status: complete. Evidence date: 2026-11-05. Dependencies: UA-TW-03 and UA-TW-04 (complete), plus UA-TW-05 for the quota windows section (complete).

## Outcome

- **Sessions tab.** The desktop app has a seventh tab, **Sessions**. It shows the same report as `token-watcher sessions`:
  - Range buttons for 7, 14, 28 or 90 days.
  - Optional toggles for quota windows (UA-TW-05) and Session Knowledge imports (UA-TW-04).
- **Sections.** The tab is laid out as follows:
  - Source coverage with the machine id.
  - Totals.
  - The weekly table.
  - The top 25 sessions.
  - Quota windows, including usage that couldn't be placed on a window.
  - Imported activity by source, with outcomes labelled as a git proxy.
  - The report notes. `n/a` means a value is not available, never zero.
- **README.** It gains a "Session usage analysis" section covering data locations, privacy, refresh, limits and rollback. Its GUI tab table now lists History and Sessions.
- **Tab bar.** It scrolls horizontally, so the seventh tab fits the default tray window.

These views answer the CLI questions that proved useful (Q1 to Q3 in the [roadmap](../usage-analysis-roadmap.md)) without a separate data path.

## Design

- **IPC.** `src/gui/ipc/sessions.ts` serves `sessions:report`, which calls `buildSessionUsageReport()` from UA-TW-03.
  - **Parameters.** They are validated in the main process. `days` must be one of 7, 14, 28 or 90 (default 28), and `windows` and `imports` must be the boolean `true`. Anything else falls back to the default.
  - **Trimming.** The report is cut down before it crosses the bridge:
    - The top 25 sessions by tokens, plus the full session count.
    - Each working directory reduced to its last path segment (`project`), so full home paths never reach the renderer.
    - At most 40 quota windows: those with usage first, then the latest.
- **Reads.** The quota history database and the import store are read only when their toggle is on. The renderer reads on tab open, on a range change and on a toggle; it doesn't poll.
- **Renderer.** It is plain DOM code in `src/gui/renderer/app.js`, built from the existing card and `data-table` styles. Missing values render as `n/a`, and missing or unreadable stores render as a message, never an empty table.

## Acceptance evidence

- **Unit tests.** `tests/gui.ipc-sessions.test.ts` (4 tests) covers:
  - Parameter validation.
  - The range passed to the readers.
  - Directory reduction: no home path in the payload.
  - The 25-session cap with the full count.
  - Windows and imports read only when requested.
- **Installed GUI smoke.** `pnpm run smoke:gui` installs the packed tarball and starts Electron against an isolated `HOME` with a seeded OpenCode database. The Sessions tab calls the real `sessions:report` handler, and the smoke checks for "3 sessions, 3 responses": the three seeded messages inside 28 days, with the 40-day-old one excluded.
- **Packaged app smoke.** `scripts/smoke-packaged-app.mjs` now expects seven tabs and checks the Sessions tab's notes. It runs in the desktop-artifacts workflow, and both smokes clear `CODEX_HOME` and `TOKEN_WATCHER_IMPORT_STORE` so the host's data can't leak in.
  - It was run locally on 2026-11-05 against an ad-hoc-signed `electron-builder --mac --dir` build. Result: 7 tabs, no exceptions.
  - A screenshot of the Sessions tab showed the coverage rows ("no local store found" for Claude Code and Codex in the isolated profile), the empty-state message and the notes.
- **Local gates (macOS, Node 22).** All passed:
  - `pnpm run typecheck`.
  - `pnpm test`: 171 files, 1,797 tests.
  - `pnpm run build:check`.
  - `pnpm run smoke:gui`.

## Limits

- **Linux not run locally.** Only macOS was run on this machine. Linux relies on CI: the `desktop-smoke` jobs, and the desktop-artifacts AppImage smoke when that workflow runs.
- **No real Session Knowledge export.** The imports section has only been checked against fixtures, as recorded in [UA-TW-04](UA_TW04_SESSION_KNOWLEDGE_IMPORT.md).
- **This machine only.** The Sessions tab shows this machine's sessions. Other machines appear in the dashboard's All machines token view through `token-sync` (UA-TW-06), not in this tab.
- **CLI wording in notes.** The notes repeat the CLI report notes, so some mention flags such as `--imports`.

## Rollback

- Remove the Sessions entry from `TABS`, `renderSessionsInto()` and its helpers, and `loadSessions()`.
- Remove the `sessions:report` handler and its preload binding, and `src/gui/ipc/sessions.ts`.
- Revert the tab-bar CSS and the smoke changes (seven tabs back to six).

No data store is added or changed.
