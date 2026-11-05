# Pricing snapshot refresh and automatic re-checks

Status: complete. Evidence date: 2026-11-05. No issue; requested alongside the UA-TW-04 real-data validation.

## Outcome

- **Bundled snapshot refreshed.** `src/data/modelsdev-pricing.min.json` was regenerated from models.dev on 2026-11-05; the previous copy dated from 2026-03-23. It now prices the Claude 5, GPT-5.5 and GPT-6 families.
- **Retired models keep their price.** models.dev had dropped 73 models since the last snapshot, such as `claude-sonnet-4-20250514`, `gpt-5.2-codex` and `grok-code-fast-1`. Replacing the snapshot wholesale would have left sessions on those models unpriced and broken three resolver coverage tests.
  - Both the maintainer script (`pnpm run pricing:refresh`) and the runtime refresh now keep a model's last known price when it disappears upstream. Fresh prices always win.
  - The runtime refresh fills gaps from the previous runtime copy and then the bundled copy. It does this on a `304 Not Modified` too, so a runtime copy written by an older version regains the missing models.
- **Desktop app re-checks.** The tray app checks 30 seconds after launch and every 6 hours (`src/gui/pricing-auto-refresh.ts`). Before this change the plugin, CLI and app each checked once per process, so an app left open never refreshed.
  - The new `recheck` option to `maybeRefreshPricingSnapshot` bypasses only the once-per-process guard. Staleness against `pricingSnapshot.autoRefresh`, the 6-hour attempt throttle and the `bundled` selection still apply.
- **CLI for scheduled jobs.** `token-watcher pricing [status]` shows the active snapshot, its age and the last attempt. `token-watcher pricing refresh` fetches only when the snapshot is stale, and `--force` fetches now. Both commands accept `--json`. The exit code is 1 when a fetch fails and 2 for bad arguments. The README has a cron example.

## Acceptance evidence

- **Tests.**
  - `tests/pricing-auto-refresh-policy.test.ts` covers:
    - A recheck while fresh fetches nothing, and a recheck once stale fetches.
    - Without `recheck` the second check in a process is skipped.
    - The bundled selection is never fetched.
    - Retired models are kept on a 200 and on a 304.
    - Providers outside the allowlist are not retained.
    - Merge precedence.
  - `tests/gui.pricing-auto-refresh.test.ts` covers the first delay, the interval, failure recovery and disposal.
  - `tests/cli-pricing.test.ts` covers status, refresh with and without `--force`, the configured age, the failure exit code and argument errors.
- **Real run (macOS).** `token-watcher pricing refresh --force` wrote a 204-model runtime snapshot. On the real `token-watcher sessions --since 2026-06-01` report, the priced share of tokens rose from 0.1% to 89.4%.
- **Local gates (macOS, Node 22).** All passed:
  - `pnpm run typecheck`.
  - `pnpm test`: 173 files, 1,813 tests.
  - `pnpm run build:check`.
  - `pnpm run smoke:gui`.

## Limits

- **Stale prices for retired models.** A retained model's price is never updated again, which is acceptable for models no longer sold.
- **Provider allowlist.** Only six models.dev providers are snapshotted: anthropic, google, moonshotai, openai, xai and zai. Models reached through other providers need custom pricing.
- **Real fetch on macOS only.** The automatic re-check was exercised by unit tests and the CLI run, not by leaving the packaged app open for six hours.

## Rollback

- Remove `startPricingAutoRefresh()` from `src/gui/main.ts`, along with `src/gui/pricing-auto-refresh.ts`, `src/lib/cli-pricing.ts` and the `pricing` command entry.
- Drop the `recheck` option and `retainRetiredModels()`.
- Delete `modelsdev-pricing.runtime.min.json` in the cache directory to fall back to the bundled snapshot.
