# UA-TW-06 cross-machine usage on one channel

Issue: [#73](https://github.com/thanhndv212/token-watcher/issues/73) (epic [#67](https://github.com/thanhndv212/token-watcher/issues/67)). Status: complete. Evidence date: 2026-11-05. Dependencies: UA-TW-01 and UA-TW-03 (both complete).

## Decision

Extend `token-sync` rather than retire it. Session Knowledge does not export usage records yet (UA-SK-05 is open), so it can't be the cross-machine channel today. `token-sync` already moves files between machines through git, and the dashboard's **All machines** view and **↗ Sync** button already use it. The new format reuses the UA-TW-03 session loaders and the UA-TW-01 machine identity, so cross-machine totals and `token-watcher sessions` count sessions the same way.

## Format version 3

`src/lib/token-sync-v3.ts` defines `token-sync/<machineId>.v3.json`. It is written next to the existing version 2 file, `token-sync/<hostname>.json`, and does not replace it.

- **All three native sources.** It holds Claude Code, OpenCode and Codex sessions. Version 2 held OpenCode only.
- **Root sessions.** Each record is one root session (subagent sessions roll up into their parent). It has the source, the session id, the first and last response times, and per `provider/model` counts: responses, input, output, reasoning, cache read and cache write. Version 2 kept one model per session and no response count.
- **Machine identity.** Files are keyed by the Session Knowledge machine id when the host is mapped, otherwise by the hostname (UA-TW-01). Each file records `hostname`, `mapped`, and the read status of each source, so a source read with no sessions counts as a real zero, not missing data.
- **No text.** Only ids, timestamps, model names and counts are stored. Titles and message content never reach the file.
- **Deterministic.** Sessions and models are sorted, so repeated exports of the same data differ only in `exportedAt`.

`exportTokenSync()` writes both files. It still returns the version 2 export, so the GUI's existing toast and push flow are unchanged. The push step stages the whole `token-sync/` directory, so the version 3 file is committed with it.

## Merge rule

`loadMergedTokenUsage()` now reads local usage from all three sources through `loadSessionMessages()`, the same loader as the session report. It then merges remote files with `mergeRemoteSessions()`:

- **Key.** Each session is keyed by `(source, sessionId)` and counted once. Local sessions come first, by both root and raw session id. Remote files are ordered version 3 first, then newest export first, then by file name. A session found again is recorded as a duplicate of that file, not counted.
- **Own files.** This machine's files are never read back as remote usage. A version 3 file is this machine's own when its machine id or its normalised hostname matches. A version 2 file is matched by normalised hostname. Because local usage is read directly, sessions in older files from earlier hostnames of this machine are also caught as duplicates.
- **Migration.** A version 2 file is skipped as `superseded` once a version 3 file exists from the same host. Remote hosts that have not upgraded are still read from version 2.
- **Invalid files.** A file that fails validation is skipped as a whole and listed as `invalid`. Validation covers the version, single-line ids of at most 200 characters, non-negative integer counts, known sources, at most 100,000 sessions and at most 50 models per session. One bad session rejects the file, so a partly-read machine is never counted.
- **Report.** The result adds `machines` (per file: version, sessions counted and duplicates) and `skippedFiles` (with the reason). Version 2 sessions count as one message each, because that format records no responses.

## Acceptance evidence

- `tests/lib.token-sync-v3.test.ts` (26 tests) covers:
  - Building the export: grouping by root and model, first and last times, deterministic output regardless of input order, zero-token responses skipped, no title or content stored, safe file names.
  - Parsing: a version 3 round trip, version 2 read as OpenCode with unknown responses, and nine kinds of invalid file, plus whole-file rejection when one session is bad.
  - Merging:
    - Mac and Linux records stay distinct.
    - Own v2 and v3 files are skipped, including a v3 file whose machine id changed after mapping.
    - Local sessions aren't counted again, and OpenCode sessions match by raw id as well as root.
    - The same id from two sources counts twice.
    - A session that appears in two other machines' files is counted once, from the newest export.
    - A repeated merge with files in a different order gives the same result.
    - Invalid files are reported.
  - Migration (v3 supersedes the same host's v2) and rollback (with no v3 file, v2 is read).
- `tests/lib.opencode-storage.test.ts` checks that the export writes a version 3 file beside the corrected version 2 totals, and that the merge reports no other machines.
- **Local run on 2026-11-05 (macOS)** against a copy of `~/.config/opencode/opencode-quota/token-sync` (three version 2 files, all from this Mac under earlier hostnames):
  - The export took 3.4 s. It wrote 206 version 2 sessions and 227 version 3 root sessions: 139 Claude Code, 79 OpenCode and 9 Codex.
  - The merge skipped this machine's own two files and read the two older-hostname files. Their 186 and 165 sessions were all duplicates of local sessions, so none was counted twice.
  - Two merges in a row gave the same totals: 227 sessions and 33,835 messages.
- **Local gates.** `pnpm run typecheck`, `pnpm run build` and `pnpm test` passed. The project's Node 22 CI is the reference run.

## Limits and follow-ups

- **No second machine yet.** No Linux export was available, so a real two-machine merge was checked with fixtures only.
- **Unmapped hosts.** This Mac has no Session Knowledge registry, so its id is its hostname. If a machine is mapped later, its new id file still matches its old one by hostname. A machine whose hostname also changes leaves an old file that the merge reads as another machine; delete that file from the sync repository.
- **Pricing gaps.** Cost uses the same pricing lookup as before. Models missing from the bundled snapshot, such as `claude-opus-5-5`, are priced at $0, as they were before this change.
- **Not in `sessions` yet.** `token-watcher sessions` still reports this machine only. A per-machine view arrives with the GUI work in UA-TW-07.
- **Export cost.** The export now reads all three local stores, which takes a few seconds on this Mac.

## Rollback

Downgrade Token Watcher, or revert this change. Older versions keep reading the version 2 files, which are still written, and they skip `.v3.json` files because their version is not 2. Delete `token-sync/*.v3.json` from the sync repository to clean up. Nothing else is stored.
