# Security

## What this plugin can do to your machine

Gatekeeper generates configuration and, when you ask it to, runs commands. Both
paths are deliberately narrow, and both are worth knowing before you install it.

**It writes files only through `py-scaffold`, only on `dryRun: false`, and only
to nine fixed targets** (`pyproject.toml`, `.pre-commit-config.yaml`,
`.github/dependabot.yml`, the workflow file, `scripts/ci.py`,
`scripts/validate_version_manifest.py`, `scripts/secret_scan.py`,
`scripts/container_report.py`, `release/agent_versions.json`). Every overwrite
leaves the previous file beside it as `<name>.bak.<timestamp>`. Nothing is
written outside the project root.

**It runs commands only through `py-run`, only from a fifteen-entry argv
allowlist** (`uv`, `ruff`, `pytest`, `docker`, `git`, …). The argv is matched
literally — a refused command never reaches `spawn`. `rm -rf /` is a test case,
not a hypothetical. Stages run sequentially and stop at the first failure, with
a 300 s per-stage cap and a 900 s budget.

**It does not phone home.** No telemetry, no update check, no network request of
its own. The only outbound traffic is whatever `uv` / `pytest` / `docker` you
asked it to run does.

**Its HTTP routes are unauthenticated** (`/gatekeeper/status`,
`/gatekeeper/preview`), like other DSH plugin routes. They are read-only and
serve the state of the session's current project on `127.0.0.1`. They are not
exposed beyond the loopback interface by DSH.

## Reporting a problem

Open a private security advisory on the repository
(Security → Advisories → Report a vulnerability), or email the address in the
`author` field of `package.json`. Please do not open a public issue for
something that lets a command escape the allowlist, writes outside the project
root, or leaks a path from your machine.

Include the plugin version, the DSH version (`dsh --version`, or the version in
the app's About), and the `argv` you asked for if the report involves command
execution.
