# UA-TW-04 Session Knowledge activity and outcome import

Issue: [#71](https://github.com/thanhndv212/token-watcher/issues/71) (epic [#67](https://github.com/thanhndv212/token-watcher/issues/67)). Status: complete on the Token Watcher side, against fixtures; Session Knowledge export is pending. Evidence date: 2026-11-05. Dependencies:

- UA-TW-01 (complete).
- Session Knowledge [UA-SK-03](https://github.com/thanhndv212/session-knowledge/issues/6) (git outcome linkage) and [UA-SK-05](https://github.com/thanhndv212/session-knowledge/issues/8) (metadata-only export) are still open. The import is therefore built and tested against usage import contract 1 fixtures, the same way UA-TW-01 fixed the contract.

## Outcome

- `token-watcher sessions import <export>` imports Session Knowledge per-session records into a separate local store.
- `token-watcher sessions --imports` adds two sections to the session report:
  - Imported activity by source, with Copilot and Zcode as activity-only rows.
  - Git-proxy outcomes joined to this machine's native sessions. This answers Q3 (cost per delivered work) as a labelled proxy.
- `--json` puts the same data in an `imports` object. Without `--imports`, the store is not read and `imports` is `null`.

## Design

`src/lib/usage-import-store.ts`:

- **Separate store.** The store is `session-knowledge-imports.json`, next to the quota history database. `TOKEN_WATCHER_IMPORT_STORE` overrides the location. It is written atomically (temporary file and rename) with mode 0600, and nothing is written to the daily or provider history.
- **Input.** The input is JSON lines or a JSON array, at most 64 MB. Each record goes through `parseUsageImportRecord()`. Only its allow-listed fields are stored, so titles, prompts, messages and any other extra field are dropped. Stored records are validated again on read, so a hand-edited store can't get around the contract.
- **Idempotent and additive.**
  - Records are keyed by `(machineId, source, sessionId)`.
  - A new key is added, a changed record replaces the stored one, and an identical record is counted as unchanged.
  - Records are stored sorted, and the file is not rewritten when nothing changed, so re-importing the same export leaves it byte-identical.
  - Records are never deleted. The store holds at most 200,000 records.
- **Rejections.** A rejected line is reported by line number and reason only, never with its content. The contract parser no longer quotes a rejected `contract` value; only integer versions are echoed. The command exits 2 when any line is rejected, and refuses to overwrite a store it can't read.
- **Source of truth.**
  - Tokens follow the UA-TW-01 rule. For `claude-code`, `opencode` and `codex`, tokens always come from Token Watcher's native readers, and imported counts are ignored (`tokens from: native`).
  - Other sources contribute tokens only when the record reports them (`import`), otherwise they are activity-only (`none`).
  - Missing counts stay `n/a`, never zero.
- **Range.** Records are placed by `startedAt` within `--since`/`--until`. Undated records are counted but not placed.
- **Outcomes.**
  - Outcomes are the commits and pull requests Session Knowledge linked to a session (`git-proxy`). Output labels them as a proxy, not proof of delivered work.
  - Sessions from this machine are joined to native sessions in range by `(machineId, source, sessionId)` to give tokens, cost, distinct commits and cost per commit.
  - Linked sessions with no native match, and linked sessions from other machines, are counted separately and never priced.

## Acceptance evidence

- `tests/lib.usage-import-store.test.ts` (11 tests) covers:
  - Re-importing the same fixtures as JSON lines, in another order and as an array: no duplicates, and the store stays byte-identical.
  - Updates by key.
  - Extra text fields and a fake API key are never stored or echoed, and rejected lines are reported by number and reason only.
  - Refusing to overwrite an unreadable store, and rejecting a hand-edited invalid store.
  - Copilot and Zcode as activity-only rows. Native tokens are never taken from imports, and reported tokens are counted for non-native sources.
  - The outcome join, with matched, unmatched-local and other-machine sessions.
  - Missing and unreadable stores, and the store path override.
- `tests/lib.session-usage.test.ts` checks that the store is not read unless requested and that a failing read is reported as unavailable.
- `tests/lib.cli-sessions.test.ts` checks:
  - The `--imports` flag, the activity-only row and the git-proxy label.
  - The no-imports message.
  - `sessions import` output and exit code 2 on rejections, and its argument check.
- **Local run on 2026-11-05 (macOS)** with `TOKEN_WATCHER_IMPORT_STORE` pointing at a temporary file. The fixture held a record for a real Claude Code session on this Mac, linked to commit `cca07b6` and PR #82, plus a Copilot record, a Zcode record and a contract 2 record.
  - **Import.** The first import added 3 and rejected 1 (`unsupported contract 2`) and exited 2. The second reported 3 unchanged, and the store's hash was the same.
  - **No text stored.** The record's `title` was not stored, and the store was mode 0600.
  - **Report.** `sessions --since 7d --imports` showed the Claude Code row with native tokens, and Copilot and Zcode as activity-only rows. The outcome line read: "1 matched native sessions, 53.8M tokens, n/a cost, 1 commits". Cost is n/a because `claude-opus-5-5` is not in the bundled pricing snapshot.
- **Local gates.** `pnpm run typecheck`, `pnpm run build` and `pnpm test` passed. The project's Node 22 CI is the reference run.

## Limits and follow-ups

- **No real export yet.** Session Knowledge does not produce exports, so only fixtures and a hand-written record were imported. When UA-SK-05 lands, check its output against contract 1 or add a contract 2 parser.
- **Outcomes are a proxy.** A linked commit doesn't show the session produced it, and a session can link to commits made by others. Cost per commit is reported only for matched sessions on this machine.
- **This machine's tokens only.** Outcome sessions from other machines are counted, but their tokens aren't joined here. UA-TW-06 sync files could provide them later.
- **Pricing gaps.** Cost depends on the pricing snapshot, as in the rest of the session report.
- **No GUI yet.** GUI views and user documentation arrive in UA-TW-07.

## Rollback

Remove the `import` subcommand, the `--imports` flag and `formatImportLines()`, the `imports` report field with its `readImports` dependency, and `src/lib/usage-import-store.ts`. Delete `session-knowledge-imports.json` to remove imported data. No other store is changed.
