# Coding-agent usage analysis roadmap

**Status:** Planned; implementation has not started. Revised 2026-10-18.  
**Scope:** Token Watcher session-level usage reports, a native Codex reader and import of activity/outcome metadata from Session Knowledge.  
**Companion plan:** [Session Knowledge usage analysis roadmap](https://github.com/thanhndv212/session-knowledge/blob/master/docs/usage-analysis-roadmap.md) (outcome linkage, Copilot/Zcode activity, cross-machine session metadata).

## Objective

Help Thanh see, over time, where coding-agent tokens go and which working habits are expensive, across Claude Code, OpenCode, Codex, GitHub Copilot and Zcode on macOS and Linux. The output is a local, deterministic workflow analysis, not a provider billing statement.

## Questions the analysis must answer

Every metric and view in this roadmap exists to answer one of these. Add a question before adding a metric.

| ID | Question | Primary measures |
| --- | --- | --- |
| Q1 | Is my cache reuse improving or degrading over time? | Cache-read share of input tokens per session and per week, by tool/model. |
| Q2 | When does a long session stop paying off? | Tokens per turn and cache-read share by turn index/session length; sessions above a size threshold. |
| Q3 | What does a unit of delivered work cost per tool/model? | Tokens (and estimated USD where priced) per session with a linked commit/PR; sessions with no linked outcome. |
| Q4 | How much usage is subagent or parallel-session overhead? | Share of tokens in subagent/sidechain sessions where the source marks them; concurrent sessions per hour. |
| Q5 | How does my local usage line up with quota windows? | Session tokens inside each provider's 5-hour/weekly window, beside the quota percentages Token Watcher already tracks. |

These are trend indicators. Token counts alone cannot establish code quality or that a task was completed efficiently; Q3 depends on an explicitly labelled outcome proxy.

## Current baseline

Token Watcher already provides much of the substrate; this roadmap extends it rather than adding a parallel pipeline.

- Native readers: OpenCode (`src/lib/opencode-sqlite.ts`, `src/lib/opencode-storage.ts`) and Claude Code transcripts (`src/lib/claude-code-cli-storage.ts`, deduplicated by message ID).
- Reports: `/tokens_session`, `/tokens_session_all`, `/tokens_today|daily|weekly|monthly|all`, `/tokens_between` and CLI `token-watcher show`.
- Cross-machine sync: `src/lib/token-sync.ts` exports per-session OpenCode totals to `token-sync/<hostname>.json` through git.
- No Codex, Copilot or Zcode session usage; no outcome linkage; no per-turn or cache-ratio trend views.

## Source-of-truth rule

One owner per value, so no session is counted twice.

| Source | Token values owned by | Activity / outcome metadata | Notes |
| --- | --- | --- | --- |
| Claude Code | Token Watcher native reader | Session Knowledge import | Imported token fields for this source are ignored. |
| OpenCode | Token Watcher native reader | Session Knowledge import | Session totals only unless message-level counts are verified. |
| Codex | Token Watcher native reader (UA-TW-02) | Session Knowledge import | Cumulative vs per-turn semantics must be proven by fixtures. |
| GitHub Copilot | None (unavailable) | Session Knowledge import | Activity only. Organization/enterprise metrics are not per-session tokens. |
| Zcode | None until its native store is verified | Session Knowledge import | Activity only. |

Join key: `(machineId, source, sessionId)`. Token Watcher maps its own hostname to `machineId` using the Session Knowledge machine registry (`~/session-trace-data/machines.json`) so both tools use one machine identity; an unmapped host keeps its hostname and is shown as unmapped.

## Measurement and privacy contract

- Reported and unavailable values are distinct states; missing values are never zero. Every value carries source, machine, model, time range and method.
- Reported counts are what the source logged, not subscription quota consumption or billed tokens.
- Token estimation from captured text is **deferred** (see below). Sources without reported counts show activity measures only.
- Token Watcher never stores conversation text, prompts, tool payloads or credentials. Imports are metadata and aggregates only.
- No LLM, remote tokenizer or analytics service in any import or report path; output is local and deterministic.

## Import record (contract example)

Session Knowledge produces, and Token Watcher consumes, one record per session. All fields other than the key are nullable. The canonical definition belongs to UA-TW-01 / UA-SK-02; this example is the starting point.

```json
{
  "contract": 1,
  "machineId": "mac-studio",
  "source": "copilot-chat",
  "sessionId": "8f1c…",
  "parentSessionId": null,
  "isSubagent": false,
  "projectId": "token-watcher",
  "startedAt": "2026-10-18T08:02:11Z",
  "endedAt": "2026-10-18T08:47:40Z",
  "models": ["gpt-5"],
  "activity": { "userTurns": 14, "assistantTurns": 14, "toolCalls": 37 },
  "usage": { "method": "unavailable" },
  "outcome": {
    "method": "git-proxy",
    "commits": ["88a8c6a"],
    "pullRequests": ["thanhndv212/token-watcher#65"]
  }
}
```

`usage.method` is `reported` or `unavailable`; `estimated` is reserved for the deferred estimator. When `reported`, `usage` adds `input`, `output`, `cacheRead`, `cacheWrite` and `reasoning` with per-field nulls.

## Delivery work items

| ID | Status | Deliverable and acceptance evidence | Depends on |
| --- | --- | --- | --- |
| UA-TW-01 | Planned | Agree the import record and source-of-truth rule above with Session Knowledge; implement hostname→`machineId` mapping. Tests prove an imported record for a natively read source never changes token totals. | UA-SK-01 |
| UA-TW-02 | Planned | Native Codex reader for `~/.codex/sessions/**/*.jsonl` feeding existing token reports and pricing. Fixtures cover cumulative and per-turn usage events, resumed sessions and duplicated records; totals reconcile with the fixture. | — |
| UA-TW-03 | Planned | Session usage report: `token-watcher sessions [--since] [--json]` plus a weekly trend, answering Q1, Q2 and Q4 for Claude Code, OpenCode and Codex (turns, duration, cache-read share, tokens per turn, model mix, subagent share where marked). Reports state source coverage and gaps. | UA-TW-02 for Codex rows |
| UA-TW-04 | Planned | Idempotent, additive import of Session Knowledge records (activity, project, outcome) stored separately from existing daily/provider history. Re-import of the same fixtures produces no duplicates; Copilot/Zcode appear as activity-only rows. Enables Q3. | UA-TW-01, UA-SK-03, UA-SK-05 |
| UA-TW-05 | Planned | Q5: place session usage on the provider quota windows Token Watcher already records. Sessions outside known windows stay unattributed rather than assigned. | UA-TW-03 |
| UA-TW-06 | Planned | Consolidate cross-machine usage onto one channel: either extend `token-sync` with Claude Code/Codex sessions keyed by `machineId`, or read per-machine usage from Session Knowledge exports and retire `token-sync`. Decide from UA-TW-03 experience; provide migration and rollback for existing `token-sync/*.json`. | UA-TW-01, UA-TW-03 |
| UA-TW-07 | Planned | GUI views for the questions that proved useful in CLI form, then package/installed-artifact acceptance and documentation (data locations, privacy, refresh, limits, rollback). | UA-TW-03, UA-TW-04 |

UA-TW-02 and UA-TW-03 do not depend on Session Knowledge and should ship first.

### Deferred: token estimates

Local tokenization of captured Copilot/Zcode text is deferred. A useful estimate would need a tokenizer for each model (not all are available offline) and would still miss system prompts, tool payloads and caching, which dominate agent-session usage. Revisit only if a question above needs it, with the tokenizer and version recorded and results labelled `estimated`.

## Validation and completion criteria

- Reported totals reconcile with source fixtures; Codex fixtures prove no cumulative/per-turn double counting.
- No session contributes tokens from two paths; repeated import and sync are idempotent; Mac and Linux records stay distinct.
- Missing sources and incomplete Linux sync appear as gaps, not zero-usage periods; method and coverage are shown beside every comparison.
- No conversation text or credentials appear in Token Watcher storage, exports or logs.
- Existing quota, daily-usage and `/tokens_*` output is unchanged unless a work item explicitly changes it.
- Run `pnpm run typecheck`, `pnpm test`, `pnpm run build`, `pnpm run build:check` and, for GUI items, `pnpm run smoke:gui`. Fixture tests are not live-provider or public-release certification; record unavailable sources, platforms and history in each acceptance record.

Delivery follows [CONTRIBUTING.md](../CONTRIBUTING.md) with one `codex/usage-analysis-<item-id>` branch and PR per work item; update this table with the PR, merged commit and evidence.

## Risks and rollback

- **Double counting** between native readers, `token-sync` and imports: prevented by the source-of-truth rule and tested in UA-TW-01.
- **Codex semantics drift** across CLI versions: fixtures per observed format; unknown formats report the session as unavailable rather than guessing.
- **Machine identity mismatch**: unmapped hosts are visible, never merged.
- All new storage is additive and rebuildable from source data. Disabling an importer or reader removes its rows without touching source traces or existing quota history.
