# UA-TW-04 Session Knowledge activity and outcome import

Issue: [#71](https://github.com/thanhndv212/token-watcher/issues/71) (epic [#67](https://github.com/thanhndv212/token-watcher/issues/67)). Status: complete on the Token Watcher side; validated on 2026-11-05 against real Session Knowledge traces through a stand-in export. Session Knowledge's own export (UA-SK-05) and git linkage (UA-SK-03) are pending. Evidence date: 2026-11-05. Dependencies:

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

## Real-data validation (2026-11-05)

Session Knowledge has no export yet, so `scripts/session-knowledge-to-usage-import.mjs` stands in for UA-SK-05. It reads the trace store (`$SESSION_TRACE_DIR/traces/<machineId>/<source>/*.csf.jsonl`) and writes contract 1 records with metadata only. The run below used this Mac's real store of two machines. Only counts, ids and dates were inspected; no message content was printed or written.

**Conversion.** 1,209 trace files gave 1,207 records. Two files failed to parse as strict JSON (`SyntaxError`), and only the error class was reported.

| Machine | Source       | Sessions       | Tokens in trace header |
| ------- | ------------ | -------------- | ---------------------- |
| Linux   | claude-code  | 15             | 0                      |
| Linux   | opencode     | 279 (1 failed) | 203                    |
| Linux   | copilot-chat | 59             | 0                      |
| Linux   | zcode        | 270 (1 failed) | 0                      |
| Mac     | claude-code  | 137            | 0                      |
| Mac     | codex        | 41             | 0                      |
| Mac     | opencode     | 258            | 0                      |
| Mac     | copilot-chat | 148            | 0                      |

Two runs over the same store produced byte-identical output. The export holds no titles, first messages, workspace roots or home paths.

**Import.**

- `token-watcher sessions import` added 1,207 records and rejected none. Re-importing the same file left all 1,207 unchanged, with the same store hash.
- The store was written with mode 0600.

**Report.** `token-watcher sessions --since 2026-06-01 --imports` placed 1,023 imported sessions in range:

| Source       | Tokens from | Sessions | User turns | Assistant turns | Tool messages |
| ------------ | ----------- | -------- | ---------- | --------------- | ------------- |
| claude-code  | native      | 152      | 2,374      | 12,727          | 31,563        |
| codex        | native      | 41       | 477        | 2,892           | 6,285         |
| copilot-chat | none        | 25       | 253        | 4,331           | 5,746         |
| opencode     | native      | 537      | 2,073      | 19,348          | 9,787         |
| zcode        | none        | 268      | 776        | 6,072           | 0             |

Copilot and Zcode appear as activity-only rows, as designed. The outcomes section reported that no imported session in range has a linked commit or pull request, which is correct: none of the 1,209 trace headers has a git commit or branch.

**Reconciliation with native sessions on this Mac.** Imported and native sessions were matched by source and session id.

| Source      | Native | Imported (Mac) | Matched | Explanation                                                                                                                                                         |
| ----------- | ------ | -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude-code | 137    | 137            | 64      | Imported-only sessions date Aug 7 to Oct 5, beyond Claude Code's local retention. Native-only sessions date Oct 6 to Nov 5, after Session Knowledge's last capture. |
| codex       | 9      | 41             | 0       | Native rollouts cover Oct 22 to 25; imported sessions Jun 12 to Oct 11. Same UUIDv7 id format, no overlapping dates.                                                |
| opencode    | 85     | 258            | 85      | Every native session matched. Native lists only sessions with recorded usage.                                                                                       |

- **Ids and times agree.** Session ids keep each tool's native format, so they join without mapping. Start times of matched sessions differ by a median of under a minute.
- **Activity is not a token proxy.** Session Knowledge assistant-message counts differ from native response counts: a median ratio of 0.39 for Claude Code and 1.10 for OpenCode. This is why native tokens stay the source of truth and imported counts are labelled as activity.

**Fixes found by this run** (in the same change):

- **Machine identity.** This Mac's hostname had changed to `Thanhs-MacBook-Pro-3.local`, so hostname matching left it unmapped. Identity now prefers the native machine id Session Knowledge itself uses (see [UA-TW-01](UA_TW01_USAGE_IMPORT_CONTRACT.md)). The registry path follows `SESSION_TRACE_DIR`.
- **Desktop environment.** The desktop app now reads `SESSION_TRACE_DIR` from the login shell when launched from Finder.
- **Copilot source name.** Copilot traces live in `vscode-copilot/` but are recorded as `copilot-chat`. The converter takes the source from the trace header.

## Limits and follow-ups

- **Stand-in export.** Real traces were imported through the converter script, not Session Knowledge's own export. When UA-SK-05 lands, check its output against contract 1 or add a contract 2 parser, and retire the script.
- **Outcomes unvalidated on real data.** Real traces carry no git commit or branch, so the outcome join has been checked only with fixtures. It needs UA-SK-03.
- **Trace gaps on the Session Knowledge side.** Two trace files aren't strict JSON. Zcode headers have an empty `tokenUsage`. Mac capture appears to have stopped around Oct 5 to 12, 2026.
- **Outcomes are a proxy.** A linked commit doesn't show the session produced it, and a session can link to commits made by others. Cost per commit is reported only for matched sessions on this machine.
- **This machine's tokens only.** Outcome sessions from other machines are counted, but their tokens aren't joined here. UA-TW-06 sync files could provide them later.
- **Pricing gaps.** Cost depends on the pricing snapshot, as in the rest of the session report. On the real report, the 2026-03-23 bundled snapshot priced 0.1% of tokens, because it predates the models used since June. After the [2026-11-05 refresh](PRICING_AUTO_REFRESH.md) it priced 89.4%. The rest is DeepSeek, MiniMax, GLM, Kimi and Qwen models reached through providers outside the snapshot's six.
- **GUI.** The Sessions tab (UA-TW-07) shows the same imports section.

## Rollback

Remove the `import` subcommand, the `--imports` flag and `formatImportLines()`, the `imports` report field with its `readImports` dependency, and `src/lib/usage-import-store.ts`. Delete `session-knowledge-imports.json` to remove imported data. No other store is changed.
