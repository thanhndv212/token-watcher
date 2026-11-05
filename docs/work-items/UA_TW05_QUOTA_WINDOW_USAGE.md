# UA-TW-05 session usage on provider quota windows

Issue: [#72](https://github.com/thanhndv212/token-watcher/issues/72) (epic [#67](https://github.com/thanhndv212/token-watcher/issues/67)). Status: complete. Evidence date: 2026-11-05. Dependency: UA-TW-03 (complete).

## Outcome

`token-watcher sessions --windows` answers Q5. It shows how many local session tokens fell inside each provider quota window that Token Watcher recorded, next to the percent used it last observed for that window. `--json` puts the same data in a `quotaWindows` object. Without `--windows`, the quota history is not read and `quotaWindows` is `null`.

## Design

`src/lib/quota-window-usage.ts` rebuilds window instances from the `limits` stored in `quota_snapshots` in `quota-dashboard.db`. It opens the database read-only through `openOpenCodeSqliteReadOnly`. It does not use `DashboardApi`, because that class's constructor runs schema migrations.

- **Series.** Observations are grouped by provider, account identity, window kind (`5h`, `weekly`, `monthly`, `quota`, …), limit group and model scope.
- **Instances.** Within a series, reset times less than 5 minutes apart are treated as one instance. Recorded resets jitter by under a second between polls. The instance ends at its latest reset.
- **Start.**
  - `5h` and `weekly` windows start at the reset minus their fixed length.
  - Windows whose length isn't known start at the previous instance's reset (`previous-reset`).
  - Failing that, they start at the first observation (`first-observation`, marked `+` in text output, because the window may have started earlier).
  - An early reset clips the next instance's start, so instances of a series never overlap.
- **Mixed accounts.** One account has one instance of a limit open at a time. If two instances of the same series were observed live at overlapping times, the snapshots mixed accounts that weren't told apart. Both instances are flagged `concurrent` and marked `?` in text output, and no usage is placed in them.
- **Placement.** Each response is mapped from its session provider id to a quota provider id; `github-copilot` becomes `copilot`, and other ids are lower-cased. Each limit is then handled independently. A response is placed in the one instance that covers its time. Otherwise it is counted as unattributed with one of these reasons:
  - `no-window`: the provider has no recorded windows.
  - `outside-known-windows`: for example, a gap between 5h windows, or a time after history collection stopped.
  - `ambiguous-account`: instances of two identified accounts cover the response, or a covering instance is `concurrent`.
  - `no-provider-or-time`: the response has no provider id or no timestamp.
- **Range.** Snapshots are read from 8 days before `--since`, so a weekly window that was open at the start of the range is included. Only instances that overlap the range are reported. Text output lists instances with usage, mixed-account instances, and the latest instance of each limit.

## Acceptance evidence

- `tests/lib.quota-window-usage.test.ts` (14 tests) covers:
  - Fixture windows with jittered resets, early resets and gaps.
  - Starts for windows of unknown length.
  - Separate series for each account and model scope.
  - Mixed-account detection.
  - All four unattributed reasons. Usage outside known windows is never assigned.
  - Provider aliases and range filtering.
  - A read-only database read that skips malformed rows. A malformed `quota_data` row used to make the whole query fail inside `json_extract`; the query now checks `json_valid` first.
- `tests/lib.session-usage.test.ts` checks three things:
  - The history isn't read unless requested.
  - Usage is placed and unattributed as expected.
  - A missing history and an unreadable history are reported, not shown as empty.
- `tests/lib.cli-sessions.test.ts` checks the `--windows` flag, the table, the `?` marker for mixed accounts, unattributed lines and the no-history message.
- **Local run on 2026-11-05 (macOS)** with `token-watcher sessions --since 7d --windows`:
  - Ten Anthropic 5h windows from 2026-10-30 to 2026-11-02, showing 44–100% used, 83–512 responses and 9.6M–53.0M tokens each.
  - The weekly snapshots from 2026-10-26 to 2026-11-01 alternate between a Saturday 02:00 reset at 37–91% and a Sunday 17:00 reset at 60–94%. Both have no account identity, so they were flagged as mixed, and 4,331 weekly responses were left unattributed as ambiguous.
  - 1,632 5h responses fell outside every recorded window, either between windows or after history collection stopped on 2026-11-02.
  - OpenAI showed a monthly window that started at its first observation and had no Codex usage in range.
- **Local gates.** `pnpm run typecheck`, `pnpm run build` and `pnpm test` (168 files) all passed. The project's Node 22 CI is the reference run.

## Limits and follow-ups

- **Only polled windows.** Windows Token Watcher never polled are missing, and responses in them stay unattributed. History is only recorded while the plugin or app runs.
- **No account on responses.** Local session stores don't record which account served a response. Placement relies on there being a single covering account. Mixed accounts are detected only when their windows overlap in time. If only one account was ever polled, usage on another account is placed in its windows.
- **Legacy limits only.** Only the `limits` from snapshots are used. The richer `accounting_observations` windows (schema v2) are not used yet.
- **Local counts.** Tokens are local session counts, not the provider's billed or quota usage, and there is no conversion from tokens to percent.
- **This machine only.** Other machines arrive in UA-TW-06, and GUI views in UA-TW-07.

## Rollback

Remove the `--windows` flag, `formatQuotaWindowLines()`, the `quotaWindows` report field with its `readQuotaWindows` dependency, and `src/lib/quota-window-usage.ts`. The feature is read-only and stores nothing.
