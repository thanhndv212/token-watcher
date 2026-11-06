# Token Watcher 3.11.0

First stable release of the `@thanhndv212/token-watcher` fork. It contains everything in 3.11.0-rc.1 to rc.3 plus the coding-agent usage analysis work listed below. Desktop assets and the runtime tarball are attached to the GitHub release. The package is not published to npm, and desktop assets are unsigned (no Developer ID signing or notarization).

## Changes since 3.11.0-rc.3

- **Session usage report.** `token-watcher sessions [--since] [--json]` reports turns, duration, cache-read share, tokens per turn, model mix and subagent share for Claude Code, OpenCode and Codex, with a weekly trend and explicit source coverage and gaps ([UA-TW-03](work-items/UA_TW03_SESSION_USAGE_REPORT.md)).
- **Codex.** A native reader for `~/.codex/sessions/**/*.jsonl` feeds token reports and pricing without double counting cumulative and per-turn events ([UA-TW-02](work-items/UA_TW02_CODEX_SESSION_READER.md)). The Codex CLI login is also an OpenAI quota source, and Codex usage counts in local estimates (#77).
- **Quota windows.** Session usage is placed on the provider quota windows Token Watcher already records; sessions outside known windows stay unattributed ([UA-TW-05](work-items/UA_TW05_QUOTA_WINDOW_USAGE.md)).
- **Cross-machine sync.** `token-sync` format version 3 carries Claude Code, OpenCode and Codex sessions keyed by machine ([UA-TW-06](work-items/UA_TW06_CROSS_MACHINE_SYNC.md)).
- **Session Knowledge import.** `token-watcher sessions import` adds activity, project and git-proxy outcome records in a separate store; imported records never change natively read token totals ([UA-TW-01](work-items/UA_TW01_USAGE_IMPORT_CONTRACT.md), [UA-TW-04](work-items/UA_TW04_SESSION_KNOWLEDGE_IMPORT.md)).
- **Desktop.** A new Sessions tab ([UA-TW-07](work-items/UA_TW07_GUI_SESSION_VIEWS.md)); the dashboard shows the account email and per-window reset countdowns (#78).
- **Pricing.** The bundled models.dev snapshot is refreshed and re-checked automatically ([record](work-items/PRICING_AUTO_REFRESH.md)).
- **Fixes.** The correct Claude OAuth keychain account is selected when several exist (#65). The canonical repository name is now Token Watcher (#64).

## Compatibility and upgrade

- Existing settings, credentials, caches, history databases and the Electron profile keep their locations. Quota output, `show --json` schema v1 and deterministic `/quota` and `/tokens_*` commands are unchanged.
- New stores are additive: `session-knowledge-imports.json` and `token-sync/*.v3.json`. Version 2 sync files are still written, so machines on older versions keep reading them.
- Reset notifications remain opt-in. OpenCode 2 is not supported yet (deferred M6).

## Downgrade

Install the 3.11.0-rc.3 assets. Older versions ignore `token-sync/*.v3.json` and the import store; delete them to clean up. As before, keep private schema-migration backups and never open a newer database with an older writer.

## Validation and limits

Local validation on 2026-11-07 (macOS arm64, Node 26.4.0, Electron 42.5.0): typecheck, 1,813 tests, `build:check` (installed-tarball consumer) and `smoke:gui`. The desktop-artifacts workflow builds, installs and smoke-tests the exact DMG and deb from the tag; its manifests and checksums are attached to the release. CI covers Node 20/22 tarball consumers and Linux/macOS Electron.

These checks use fixtures. They don't certify live provider responses (OpenRouter and Kilo were never tested with a live credential), signed or notarized distribution, or Session Knowledge's own export, which hasn't shipped yet (import outcomes were checked through a stand-in export script).
