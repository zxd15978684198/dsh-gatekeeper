# Contributing

## Getting a dev copy running

Gatekeeper lives as a `link:` dependency of a DSH profile, so the plugin you edit
and the plugin the host loads are the same files — no build step, no copy.

```bash
git clone https://github.com/zxd15978684198/dsh-gatekeeper.git
cd dsh-gatekeeper
```

Then point a profile at your checkout:

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
{
  "dependencies": { "gatekeeper": "link:/path/to/dsh-gatekeeper" },
  "dsh": { "profile": { "bundles": ["gatekeeper"] } }
}
```

Install dependencies in that profile, restart DSH, and the panel appears.
Client edits need only a page refresh; Host edits need a restart.

## The four test suites

Everything is plain Node with `node:test`-free hand-rolled checks and no test
runner to install:

```bash
node test/smoke.mjs        # Host side: tools, pipeline, refusal paths, generated files
node test/client.mjs       # Client side: slot registration, placement math, the chip
node test/exec-async.mjs   # Executor: async spawn, timeout, cancel, refusal

# or all three at once
npm run test:all
```

The client suite runs `client/panel.js` against a small React shim, so pure
functions used by the UI must stay importable and side-effect free
(`placementSolve`, `detailOffset`, `arrowOffset` are exported that way on
purpose).

## The audit probes

`scripts/audit/` holds the compatibility probes that were used to bring this
plugin from DSH 0.2.1 to 0.2.2. They are not part of the shipped plugin, but they
are kept runnable:

```bash
node scripts/audit/version-audit.mjs   # four layers against the installed DSH
node scripts/audit/verify-fixes.mjs    # one assertion per regression this plugin fixed
node scripts/audit/verify-async.mjs    # end-to-end: real uv, real project
```

They resolve paths from their own location and from `DSH_PROFILE_DIR` /
`DSH_HOME` / `DSH_PROFILE`; set `DSH_PROFILE_DIR` if your profile lives somewhere
unusual.

## What a good change looks like

- **One concern per commit**, with the reason in the message. "Why" beats "what":
  the history is the only place the reasoning survives.
- **A regression test that fails before the fix.** Every entry in
  `docs/audit/version-audit.md` has one; new behaviour gets one too.
- **No new runtime dependency.** The Host half runs inside DSH's own runtime;
  `react` and `@deepseek-ai/schemastery` are provided by it, everything else must
  be Node's standard library.
- **No behaviour change in a compatibility fix.** When the host moved, the fixes
  were shaped to keep the plugin's surface identical; the same applies to yours.

## Reporting

Bugs and incompatibilities: open an issue with the DSH version, the plugin
version, and the exact `argv` or panel state. Security issues: see
[SECURITY.md](SECURITY.md).
