# Audit trail

These are the working documents from bringing this plugin from DSH 0.2.1 to
0.2.2, kept as they were written rather than tidied afterwards. They contain dead
ends and corrections, because that is what an audit looks like while it is
happening.

| File | What it is |
|---|---|
| `version-audit.md` | The report: findings F1–F10, the minimal fix for each, the fix order, and the evidence index |
| `host-contract.md` | Host-side services, events and config schemas, read from the live host |
| `client-half.md` | Slots, the composer, the slash trigger source, and what could not be verified |
| `runtime-evidence.md` | Reproductions of the failures that were actually visible at runtime |
| `verify-round2.md` | An independent second opinion, explicitly listing what it could not check |
| `placement-sim.html` | A standalone browser page that reproduces the popover containing-block bug in three layout modes |

## Two things to know before reading

**The measurements were taken against DSH 0.2.2-rc.1.** A later re-check against
0.2.2-rc.5 (the release that replaced it) confirmed the parts that would break
first: `py-audit` runs and its output still serializes losslessly,
`/gatekeeper/status` answers with `degraded: false` and its 16 skills, and the
`sidebar.panellist` and `conversation.input.dock` seats are both still occupied
and active. The version numbers inside the reports are the ones that were true
when they were written.

**Some paths in the reports point at files that are not here.** The one-off
diagnostic scripts lived in the author's working tree (`audit/tmp/…`) and were
deliberately not published. Absolute paths were replaced with placeholders
(`<DSH_HOME>`, `<checkout>`, `<install>`, `<project>`); the findings do not depend
on them, only the machine they were reproduced on. The probes worth keeping were
rewritten to be checkout-relative and moved to
[`../../scripts/audit/`](../../scripts/audit/), where they still run:

```bash
node scripts/audit/version-audit.mjs
node scripts/audit/verify-fixes.mjs
node scripts/audit/verify-async.mjs
```
