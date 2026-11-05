# UA-TW-01 usage import contract and source-of-truth rule

Issue: [#68](https://github.com/thanhndv212/token-watcher/issues/68) (epic [#67](https://github.com/thanhndv212/token-watcher/issues/67)). Status: complete on the Token Watcher side; Session Knowledge adoption is pending. Evidence date: 2026-11-05. Dependencies: Session Knowledge [UA-SK-01](https://github.com/thanhndv212/session-knowledge/issues/4) and [UA-SK-02](https://github.com/thanhndv212/session-knowledge/issues/5) are still open, so the contract is defined here first and Session Knowledge's export must match it.

## Contract

`src/lib/usage-import-contract.ts` defines contract version 1: one record per session, keyed by `(machineId, source, sessionId)`. It matches the example in the [usage analysis roadmap](../usage-analysis-roadmap.md#import-record-contract-example).

- **Parser.** `parseUsageImportRecord()` returns either a record or one error message. It copies allow-listed fields only. Titles, messages, prompts, tool payloads and any other extra field are dropped, so they can't reach Token Watcher storage or output.
- **Identifiers only.** Ids are single-line strings of at most 200 characters, and lists hold at most 50 entries. `source` is a lower-case id. Commits must be 7–40 hex characters, and pull requests must look like `owner/repo#n`.
- **Missing is not zero.** Counts are non-negative integers or `null`. Missing activity, usage fields, project, timestamps and outcome are all `null`, and timestamps are converted to epoch milliseconds.
- **Usage method.** `usage.method` is `reported` or `unavailable`. `estimated` is reserved for the deferred estimator and rejected.
- **Outcome.** The outcome method is `git-proxy` or `none`; `none` is stored as no outcome.
- **Versioning.** Any other `contract` value is rejected. A future version needs a new parser branch.

### Source-of-truth rule

- **Native sources.** `tokenOwner()` returns `native` for `claude-code`, `opencode` and `codex`. These are the sources with Token Watcher readers (`SESSION_USAGE_SOURCES`).
- **Other sources.** It returns `import` when the record reports usage, otherwise `none`. Copilot and Zcode are activity-only until their exports report counts.
- **Single entry point.** `importedTokenUsage()` is the only way a report may take imported tokens. It returns `null` for native sources even when the record reports usage, so an import can never change a native total.

### Machine identity

`src/lib/machine-identity.ts` maps this host into Session Knowledge's registry at `~/session-trace-data/machines.json`, whose shape is `{ "<machineId>": { "hostname": "…" } }`.

- **Matching.** Hostnames match exactly after lower-casing and removing a trailing `.local`.
- **Unsafe entries never match.** An entry with an empty or missing hostname never matches. Session Knowledge's current capture adapters treat it as matching any host, which UA-SK-01 tracks as a bug.
- **Unmapped hosts.** If there is no registry, the registry can't be read, no entry matches, or the match is ambiguous, the host keeps its hostname as its id. It is reported as unmapped with the reason, so two machines are never merged.
- **Report surface.** `token-watcher sessions` prints a `Machine:` line. Its `--json` report has a `machine` object with `machineId`, `hostname`, `mapped` and `status`.

## Acceptance evidence

- `tests/lib.usage-import-contract.test.ts` covers:
  - The roadmap example record and nulls for missing values.
  - Dropping extra text fields, including a fake API key.
  - Rejecting multi-line or oversized identifiers, unsupported contracts, the reserved `estimated` method, and invalid counts, timestamps and outcome refs.
  - The source-of-truth rule for all three native sources and for reported or activity-only other sources.
  - Key distinctness.
- `tests/lib.machine-identity.test.ts` covers:
  - Exact and normalised matches, and that empty-hostname entries never match.
  - Ambiguous matches; missing, unreadable and wrongly shaped registries.
  - Two unmapped hosts staying distinct, and labels.
- `tests/lib.cli-sessions.test.ts` asserts the `Machine:` line and the JSON `machine` object.
- **Local run on 2026-11-05 (macOS, Node 26.4.0).** `token-watcher sessions --since 7d` printed `Machine: Thanhs-MacBook-Pro-3.local (unmapped: no Session Knowledge machine registry)`, because this Mac has no `~/session-trace-data`.
- **Local gates.** `pnpm run typecheck`, `pnpm run build` and `pnpm test` (167 files / 1,731 tests) passed. The project's Node 22 CI is the reference run.

## Limits and follow-ups

- **Not agreed with Session Knowledge yet.** Session Knowledge does not export records yet (UA-SK-05). Contract 1 is fixed by fixtures here, and UA-SK-02 should adopt it or propose contract 2.
- **No mapped-host check.** Without a registry on this Mac, the mapped path is fixture-only, and Linux was not checked.
- **Not used by reports yet.** Imports reach reports in UA-TW-04, and cross-machine keys are used in UA-TW-06. Until then, the contract only affects the report's machine label.

## Rollback

Remove the `machine` field from `SessionUsageReport`, remove the `Machine:` line from `formatSessionUsageText()`, and delete the two new modules. Nothing is stored.
