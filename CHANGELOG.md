# Changelog

**English** · [简体中文](CHANGELOG.zh-CN.md)

Versions before 0.10.0 are not listed: the plugin was private until 0.11.0, and
the pre-0.10 history is a sequence of internal rewrites rather than releases.

## 0.11.0

The release that makes the plugin public. Behaviour is unchanged from 0.10.3
except for the executor, which no longer blocks the host while a command runs.

### Fixed

- **`py-run` blocked the host event loop.** Every `uv` / `pytest` / `docker` call
  went through `spawnSync`; an eleven-second test run froze the GUI for eleven
  seconds. Added `runCommandAsync` / `runPlanAsync` and moved `py-run`,
  `py-container-gate` and `py-pipeline-doctor` onto them. The synchronous
  executors remain for callers that genuinely want to block, and as the control
  in the new test. Measured on a live host: a 11.1 s `py-run` held p50 status
  latency at 80 ms, with no sample above 1 s.
- **`py-audit` pointed at a tool that does not exist.** Its hint suggested
  `py-apply`, which was never registered. It now says what is true: `py-scaffold`
  writes, and only with `dryRun: false`.

### Changed

- Removed nine one-off probe scripts from the repository root. They were never
  part of the published package (`files` never included them).

### Added

- `test/exec-async.mjs`, `scripts/audit/verify-async.mjs`, and CI.

## 0.10.3

### Fixed

- **The hover card could slide off screen** when the composer's transform made a
  nested containing block. The card is now positioned inside the same layer as
  the panel, and its width shrinks to the room that is actually there — it no
  longer overlaps the panel below ~660 px.
- **The card's arrow was pinned to the middle of the border.** It now points at
  the hovered row, clamped to the card's frame, so the border position varies.

## 0.10.2

### Fixed

- Removed a dead module-level variable in the client and corrected two comments
  that described tools by their old names.

## 0.10.1

The compatibility release for DSH 0.2.2.

### Fixed

- **The slash menu never appeared.** `conversation.input.dock`'s trigger source
  returned an array from `candidates()`, while the host calls
  `candidates(...).then(...)`. `/` threw `[].then is not a function` inside a
  listener with no `try`, so the menu silently did nothing. Both sources are now
  `async`.
- **Every setting fell back to its default.** DSH marks this plugin's fields
  `x-cordis.volatile`, so a validated value arrives as a `{ get() }` reference
  object rather than a plain value. `resolveConfig` compared that object against
  `false` / `''` and always lost. It now unwraps before reading.
- **`py-run` returned `value is not lossless JSON`.** The stage plan was an array
  with two extra own properties (`profile`, `from`); the host's serializer
  requires an array's own keys to be exactly its indices. The selection now
  lives in a `WeakMap` keyed by the plan, and `planSelection(plan)` reads it.
- **The sidebar icon ignored its size and active state**, so it neither scaled in
  the collapsed rail nor showed selection.
- **`engines.dsh` was declared where the host does not read it.** Moved to the
  top-level `engines` field, which is what plugin compatibility checks.

## 0.10.0

First version with the current three-tool surface (`py-audit` reads,
`py-scaffold` writes, `py-run` executes), the 16 bundled skills, and the composer
chip.
