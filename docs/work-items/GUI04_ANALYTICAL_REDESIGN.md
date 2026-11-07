# GUI-04 Analytical desktop redesign

**Status:** implemented on branch `thanhndv212/analytic-ui-redesign`. It is not yet committed or merged, and the main-branch CI gate is still pending.

## Goal

The desktop app already showed the right data, but mostly as flat lists and single numbers. GUI-04 rebuilds the renderer so that each tab answers an analytical question. The questions are where quota headroom stands, how usage trends, what drives spend, how sessions are shaped and how close budgets are. The data contracts stay the same, and nothing in the redesign predicts quota exhaustion.

## Scope

| Area               | Change                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer structure | `app.js` is reduced to shell, state, loaders and modals. Shared code moves to `renderer/lib/` (`core.js` for DOM, formatting and tooltips, `charts.js` for SVG charts, `ui.js` for components). Each tab moves to its own file in `renderer/views/`.                                                                       |
| Charts             | Dependency-free SVG components: stacked columns, a line chart with gap breaks, sparklines, ranked bars, a weekday × hour heatmap, a log–log scatter, meters, a stacked share bar and a sortable table. Each chart has a Chart/Table toggle.                                                                                |
| Overview           | A 7-day spend hero with its delta against the prior 7 days, four KPI tiles with sparklines, quota headroom (most-used windows first), 30-day spend stacked by source, and an Insights list of descriptive statements read directly from the numbers.                                                                       |
| Quota              | Quota cards with severity meters and countdowns, plus fixed-window runway text from INS-03 only. History is drawn per account (with gaps between observations and reset markers), alongside confirmed resets, collapsed snapshot errors, the "What's burning your quota" ranking and the model cost breakdown.             |
| Usage              | This machine or all machines, over 7, 14, 30 or 90 days. KPIs show deltas. Daily tokens or cost are stacked by token type or source. The tab also shows the token mix, a source ranking, the "When you work" heatmap, spend by model (an unpriced model gets an "Add price" action), an all-models table and top sessions. |
| Sessions           | A coverage card, KPIs, sessions per week stacked by source, and session length comparing share of sessions with share of tokens. Also a session footprint scatter, top sessions, and the optional quota-window and Session Knowledge import cards.                                                                         |
| Alerts             | Rule cards with a gauge (current value against threshold), status pill, enable switch and plain-language rule text, sorted by severity.                                                                                                                                                                                    |
| Settings           | Pricing snapshot freshness and refresh, price overrides, the key store in each of its states (empty, locked and unlocked), and the theme setting.                                                                                                                                                                          |
| Layout and theme   | Tab bar below 720 px and sidebar from 720 px, with two-column grids from 900 px. Light, dark and system themes share one token palette (`--s1..5` series, `--q0..6` heatmap ramp, status colours).                                                                                                                         |
| Main process       | New `tokens:timeline` IPC (`src/gui/ipc/usage-timeline.ts`). It reads the OpenCode, Claude Code and Codex stores once and buckets responses by local day and hour of week, with per-source splits and a priced share.                                                                                                      |
| Build and smoke    | `scripts/build-gui.mjs` copies the whole renderer tree. `scripts/smoke-packaged-app.mjs` expects six tabs and checks one or more anchor strings per tab.                                                                                                                                                                   |

## Invariants kept

- No model calls and no network access for any figure. The timeline reads local stores only, and it holds no conversation text or session titles.
- INS-03: fixed-window figures show only the shared `runway` string, captioned "Linear average since fixed-window start; not a recent-rate prediction". Quota history is descriptive only: latest, peak, step-up and drop count.
- Partial pricing is never presented as complete. Cost subtitles state the priced share, unpriced models are labelled "No price", and `n/a` is distinct from zero.
- Quota history stays separated by account. Observations from unknown accounts form their own series, and local usage totals are labelled as not filtered by quota account.

## Validation

Evidence dated 2026-11-07, on macOS (Darwin 25.6, Apple silicon):

- Screenshots of all six tabs were taken from real local data, at 420 px in the light theme and at 1180 px in both the light and dark themes. The run produced 44 frames, with no renderer errors and no critical notices. They were captured through the Electron main process with `webContents.capturePage()`, because the menubar window hides on blur.
- The visual review led to these fixes:
  - Quota history lines no longer join across multi-day gaps.
  - "+0.0 pts" step-ups are no longer shown.
  - Long snapshot errors are collapsed.
  - Long text values in quota cards use a smaller figure size.
  - The Overview KPIs no longer wrap 3+1 at wide widths.
  - Two-column cards are top-aligned.
- `fmt.compact` dropped zeros from whole numbers, so a 300M axis label read "3M". It now trims zeros only after a decimal point and promotes `999.6K` to `1M`. `tests/gui.renderer-format.test.ts` covers this.
- `tests/gui.ipc-usage-timeline.test.ts` covers parameter validation, local-day and hour-of-week bucketing, priced-only cost and the reporting of unreadable stores.
- `pnpm run typecheck`, `pnpm run build` and `pnpm test` pass: 175 test files and 1,819 tests.

## Limits

- The renderer views do not yet have DOM-level unit tests. Coverage comes from the packaged-app smoke anchors and the screenshot review, plus unit tests for the timeline IPC and the number formatter.
- The screenshot review did not cover Linux, Windows or the packaged `.dmg`/AppImage builds. `pnpm run smoke:gui` remains the packaged gate.
- The Usage heatmap uses the renderer's current UTC offset (`tzOffsetMinutes`). Days that cross a daylight-saving change may place an hour in the neighbouring bucket.
- The default window size of 420 px is unchanged. The sidebar layout and wide grids appear only after the window is resized.

## Rollback

GUI-04 changes only the renderer, the build copy step, the smoke anchors and one IPC handler. To roll back:

1. Revert the GUI-04 commit or commits. This restores the single-file `app.js`, `index.html`, `app.css`, `build-gui.mjs` and the smoke script.
2. Remove the `tokens:timeline` handler and the preload method. No other caller uses them.

No config, cache or data-file format changed, so no migration or cleanup is needed.
