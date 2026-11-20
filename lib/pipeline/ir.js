// The pipeline IR: the single place that says what a stage is.
//
// Every output of this plugin — the GitHub workflow, the local `scripts/ci.py`,
// the panel's stage matrix, the audit report — is derived from this catalog.
// Adding GitLab later means writing a second renderer over these objects, not a
// second catalog; that is the whole point of the `ir → renderer` seam.
//
// The catalog is the course's nine-step gate carried by thirteen stages. Nine
// steps do not survive contact with a runner: `uv lock --check` and `uv sync`
// have to be separate stages because one is a *proof* ("the declarations match
// the lock") and the other is *preparation* ("install what the lock says"), and
// a renderer needs to put the sync where the runner installs dependencies while
// keeping the check where a human reads failures. The mapping, asserted by the
// smoke test:
//
//   step 1  uv lock --check                     → stage lock
//   step 2  uv sync --locked --all-groups       → stage sync
//   steps 3-4 ruff check / ruff format --check  → stage lint (two steps: one
//                                                 failure each, not one merged)
//   step 5  mypy <main paths>                   → stage type
//   step 6  validate_version_manifest.py        → stage manifest
//   step 7  pytest --cov                        → stage test
//   step 8  secret scan                         → stage security
//   step 9  uv build --all-packages --out-dir   → stage build (clean-dist, build)
//
// `integration` and `audit` are not among the nine. They are v0.6's optional
// gates, kept because the reasons that made them optional (a real database; a
// network-bound, noisy advisory feed) did not stop being true. The last three
// (`container`, `release`, `deploy`) are the delivery half: they need a daemon,
// a registry, or a live environment, so they are never in `all`.
//
// Two conventions a renderer must honour live on the objects rather than being
// re-derived in each renderer:
//
//   stage.resolver - the project fact the stage depends on: 'type' (which
//                    checker, which paths), 'build' (workspace or single
//                    package), 'coverage' (the floor comes from pyproject).
//                    Informational for the panel; the renderers use `step.by`.
//   step.by        - the `resolveProject` field that picks an argv variant out
//                    of `step.argvBy`. A template entry that is exactly
//                    `{fieldName}` expands to the resolved value, and an array
//                    value splices in as several argv entries. `applyResolved`
//                    below is that rule in code so the local and CI renderers
//                    cannot spell the same command two ways.
//
// A stage carries the *why* next to the *what* on purpose. The reason a gate sits
// where it sits is the part that gets lost first when a workflow is copied, and
// this plugin's whole claim is that its output is auditable against sources.

/** One command inside a stage: `argv` is canonical, `run` is what a shell sees. */
function runStep(id, label, argv, extra = {}) {
  return { id, label, kind: 'run', argv, verified: true, ...extra }
}

/**
 * One `uses:` step — an action, not a command.
 *
 * These exist because the second half of a pipeline is not shell: publishing to
 * PyPI, logging in to a registry, downloading an artefact, attesting provenance
 * and creating a release are all actions, and a stage that can only emit `run:`
 * cannot express them. `uses` carries the pinned action, `with` its inputs.
 *
 * @param id - step id, unique within the stage.
 * @param label - step name shown in the run log.
 * @param uses - the action reference, e.g. `pypa/gh-action-pypi-publish@release/v1`.
 * @param withInputs - `{ key: value }` for the `with:` block, or null.
 * @param extra - `{ verified, commented, note, if, env }`.
 */
function useStep(id, label, uses, withInputs = null, extra = {}) {
  return {
    id,
    label,
    kind: 'uses',
    uses,
    with: withInputs === null ? null : { ...withInputs },
    verified: true,
    ...extra,
  }
}

/**
 * A step that only makes sense on a version tag.
 *
 * The `if:` is not decoration: a publish step that runs on every push to main
 * either fails (no version) or uploads a pre-release that cannot be withdrawn.
 */
function taggedStep(id, label, uses, withInputs = null, extra = {}) {
  return useStep(id, label, uses, withInputs, {
    if: "startsWith(github.ref, 'refs/tags/v')",
    ...extra,
  })
}

/**
 * The stage catalog, in the order a failing gate should be reported.
 *
 * Order is the cheapest-failure-first rule from `3-ci-cd-and-automation`: a stale
 * lock should cost a second, not a full dependency install, and a typo should
 * cost twenty seconds, not a full test run. `optional: true` means the stage
 * cannot be in `all` by default — it needs a daemon, a registry, a network, or a
 * live environment, and including it by default would either fail on every
 * naive project or, worse, deploy something.
 */
export const STAGE_CATALOG = {
  lock: {
    id: 'lock',
    title: 'Lock check',
    replaces: 'a lockfile nobody verifies',
    why:
      'This is the cheapest possible failure and therefore the first: `uv lock --check` compares the ' +
      'declarations with `uv.lock` without resolving anything. Everything after it trusts that lock — ' +
      'a stale one would otherwise surface minutes later as a resolution error inside `uv sync` or as ' +
      'a mysteriously missing tool in the lint step, which reads like a broken gate rather than a ' +
      'stale lockfile. It is its own stage rather than a flag on `sync` because CI must render it ' +
      '*before* the install step while the local runner still reports it as a separate unit of failure.',
    steps: [runStep('lock-check', 'uv lock --check', ['uv', 'lock', '--check'])],
  },
  sync: {
    id: 'sync',
    title: 'Sync',
    replaces: 'pip install -r requirements.txt',
    why:
      'Step 2 of the course gate and the runner\'s "install dependencies" line are the same command, ' +
      'so they are the same stage: in the workflow it becomes the install step, on the laptop it is ' +
      'the step that proves the toolchain the later stages call actually exists. `--all-groups` is ' +
      'not optional — ruff, pytest, mypy and detect-secrets live in dependency groups, and a default ' +
      'sync installs none of them, which turns every later stage into "command not found".',
    steps: [runStep('uv-sync', 'uv sync --locked --all-groups', ['uv', 'sync', '--locked', '--all-groups'])],
  },
  lint: {
    id: 'lint',
    title: 'Lint',
    replaces: 'eslint + prettier',
    why:
      'Ruff is fast enough to run on every push, and it is the gate that catches the most mistakes per ' +
      'second spent. `ruff format --check` is a separate step from `ruff check` on purpose: one is ' +
      'correctness, the other is style, and a single combined step hides which of the two failed. ' +
      'The argv deliberately carries no `--output-format=github`: the same argv has to run on a laptop ' +
      'and on a runner, and a GitHub-only output flag would make this the first stage whose local and ' +
      'CI commands differ.',
    steps: [
      runStep('ruff-check', 'ruff check', ['uv', 'run', '--locked', 'ruff', 'check', '.']),
      runStep('ruff-format', 'ruff format --check', ['uv', 'run', '--locked', 'ruff', 'format', '--check', '.']),
    ],
  },
  type: {
    id: 'type',
    title: 'Type check',
    replaces: 'tsc --noEmit',
    // The renderer asks `resolveProject` for `typeChecker` and `typePaths`; the
    // argv below is the fallback that ships only when neither the project nor
    // detection answers.
    resolver: 'type',
    why:
      'The checker is a project fact, not a plugin opinion: a repository already typing with mypy keeps ' +
      'mypy, one configured for ty gets ty, and swapping checkers is its own migration rather than a CI ' +
      'decision. The paths are a project fact too — "src" is a guess, and a guess that mysteriously ' +
      'type-checks the wrong directory is worse than no stage at all. So this stage carries ' +
      '`resolver: \'type\'` and its step carries the per-checker argv templates; a renderer that ignores ' +
      'them ships the mypy-on-src fallback, which is still the most common shape but is not silently ' +
      'assumed to be correct.',
    steps: [
      runStep('type-check', 'type check', ['uv', 'run', '--locked', 'mypy', 'src'], {
        by: 'typeChecker',
        argvBy: {
          mypy: ['uv', 'run', '--locked', 'mypy', '{typePaths}'],
          ty: ['uv', 'run', '--locked', 'ty', 'check', '{typePaths}'],
        },
      }),
    ],
  },
  manifest: {
    id: 'manifest',
    title: 'Version manifest',
    replaces: 'a hand-written release checklist',
    why:
      'Version evidence is the artefact that rots silently: a prompt is edited, the manifest still lists ' +
      'the old digest, and every later claim about what is deployed inherits the lie. The validator is ' +
      'generated into the project and uses the standard library only, so it can run before any ' +
      'dependency exists; its path is fixed here rather than resolved from config because ' +
      '`scripts/ci.py` and the workflow must call the same file — two independently resolved paths ' +
      'would let the local gate and CI validate different scripts and both report green.',
    steps: [
      runStep('validate-manifest', 'python scripts/validate_version_manifest.py', [
        'uv', 'run', '--locked', 'python', 'scripts/validate_version_manifest.py',
      ]),
    ],
  },
  test: {
    id: 'test',
    title: 'Test',
    replaces: 'jest',
    // The coverage floor is a resolved project value, written into pyproject by
    // the renderer that generates `[tool.coverage.report].fail_under`.
    resolver: 'coverage',
    why:
      'Tests run after the static gates because a failing test should mean a real regression, not a ' +
      'syntax error the linter would have caught in a tenth of the time. The coverage floor is absent ' +
      'from the argv on purpose: it lives in `[tool.coverage.report].fail_under`, which the project ' +
      'template fills from the resolved value. Spelling `--cov-fail-under=80` here as well would create ' +
      'a second floor that silently wins whenever the two disagree, and the argv would then encode a ' +
      'number that is supposed to come from the project.',
    steps: [
      runStep('pytest', 'pytest', ['uv', 'run', '--locked', 'pytest', '--cov', '--cov-report=term-missing']),
    ],
  },
  security: {
    id: 'security',
    title: 'Secret scan',
    replaces: 'the Yelp/detect-secrets pre-commit remote hook',
    why:
      'A secret is the one finding that cannot be fixed by a later commit, so this gate runs on every ' +
      'push and on every commit. It calls the *generated helper* (`scripts/secret_scan.py`) rather than ' +
      '`detect-secrets` directly, because the same scan must accept "all tracked files" from CI and "the ' +
      'staged set" from a hook, and the helper owns that difference. The step is read-only by design: ' +
      'deciding that a candidate is a false positive is an audit a human performs, never something a ' +
      'pipeline may write into `.secrets.baseline`. A missing baseline is therefore a red gate that ' +
      'prints how to create one, not an empty green one — silent success on a missing baseline would ' +
      'mean the gate never ran.',
    steps: [
      runStep('secret-scan', 'python scripts/secret_scan.py', [
        'uv', 'run', '--locked', 'python', 'scripts/secret_scan.py',
      ]),
    ],
  },
  build: {
    id: 'build',
    title: 'Build',
    replaces: 'npm run build',
    // `buildMode` from `resolveProject` picks between the workspace and the
    // single-package argv; `--all-packages` is only legal in a workspace. The
    // variant key is the resolved value itself (`'workspace'` / `'package'`), and
    // `applyResolved` re-derives the build step from it so a release job can reuse
    // the same command it rendered here.
    resolver: 'build',
    why:
      'For a library, `uv build` is the packaging check: it proves the sdist and wheel actually build ' +
      'from what is committed, which tests run from a source checkout never do. The clean step is not ' +
      'hygiene theatre — a stale wheel left in `dist/` is what a later upload or release step ships ' +
      'when this build fails, so "new artefacts must replace old ones" is enforced before the build, ' +
      'not trusted afterwards. That clean step also intentionally omits `--locked`: it is a standard-' +
      'library one-liner, and it has to be able to empty `dist/` even when the environment and the lock ' +
      'disagree — which is exactly the state the stages around it are about to report.',
    steps: [
      runStep('clean-dist', 'clear dist/', [
        'uv', 'run', 'python', '-c',
        'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)', 'dist',
      ], {
        // `argv` is what the local runner executes, `run` is what a shell sees, and
        // for this one step the two cannot be the same string: the one-liner holds a
        // `;` and spaces, so a shell needs it quoted. Renderers print `run` for a
        // plain step, and an unquoted form there would split the command in two.
        run:
          "uv run python -c 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)' dist",
      }),
      runStep('uv-build', 'uv build', ['uv', 'build', '--all-packages', '--out-dir', 'dist'], {
        by: 'buildMode',
        argvBy: {
          workspace: ['uv', 'build', '--all-packages', '--out-dir', 'dist'],
          // A single package still builds into `dist/` (not uv's default
          // `dist/`-equivalent `dist`): release reuses that directory verbatim, and
          // two spellings of "where the wheel lands" is how uploads go missing.
          package: ['uv', 'build', '--out-dir', 'dist'],
        },
      }),
    ],
  },
  integration: {
    id: 'integration',
    title: 'Integration tests',
    replaces: 'database-backed API tests',
    why:
      'Integration tests sit after the build because they are the first gate that needs a real database ' +
      'or network. They are opt-in for the mirror-image reason: a project without them would run an ' +
      'empty selection, and pytest exits 5 ("no tests ran") on an empty selection — so the gate would ' +
      'be red for being absent rather than for being wrong. `pytest -m integration` makes the absence a ' +
      'deliberate project decision instead of an accident.',
    optional: true,
    steps: [
      runStep('pytest-integration', 'pytest -m integration', ['uv', 'run', '--locked', 'pytest', '-m', 'integration']),
    ],
  },
  audit: {
    id: 'audit',
    title: 'Dependency audit',
    replaces: 'npm audit',
    why:
      'pip-audit checks the locked set against the OSV database. v0.6 folded this into `security`; v0.10 ' +
      'splits them because a leaked credential and a vulnerable transitive dependency are different ' +
      'failures with different fixes, and one stage can only report one colour. The old rule still ' +
      'holds: pip-audit is the slowest and noisiest gate here, it needs a network lookup, and a ' +
      'dependency advisory must not mask a failing test — so it is opt-in and never part of a commit ' +
      'hook. `--with pip-audit` provisions the tool for the run instead of adding a dependency the ' +
      'project never asked for, which is also why this is the one stage whose tool is not in the lock: ' +
      'the point is that the gate does not require an edit to pyproject.toml.',
    optional: true,
    steps: [
      runStep('pip-audit', 'pip-audit', ['uv', 'run', '--locked', '--with', 'pip-audit', 'pip-audit']),
    ],
  },
  container: {
    id: 'container',
    title: 'Container',
    job: 'container',
    needs: ['quality'],
    optional: true,
    replaces: 'a second pipeline that only builds images',
    why:
      'A compose file that parses is not a stack that starts. This stage asks docker itself: ' +
      '`config --quiet` validates the merged file and every variable it interpolates, `build` proves ' +
      'the Dockerfile still builds from what is committed, and `up -d --wait` proves the services ' +
      'actually reach healthy. It is opt-in because it needs a docker daemon — a lint gate must never ' +
      'depend on one. The report step exists because the facts worth knowing about a built image ' +
      '(size, layer count, the user it runs as, dev dependencies that leaked into it, a missing ' +
      '.dockerignore, a single-stage build) are mostly advisory: failing a gate on a missing ' +
      '.dockerignore would teach people to delete the gate, so it reports, and only a configured ' +
      '`max_size_mb` turns it into a failure.',
    steps: [
      runStep('compose-config', 'docker compose config --quiet', ['docker', 'compose', 'config', '--quiet']),
      // `build --check` is the cheap half of `build`: it answers "would this build
      // succeed" without producing an image, so a broken Dockerfile fails here
      // rather than after the slowest step in the pipeline.
      runStep('compose-build-check', 'docker build --check .', ['docker', 'build', '--check', '.']),
      runStep('compose-build', 'docker compose build', ['docker', 'compose', 'build']),
      runStep('compose-up', 'docker compose up -d --wait', ['docker', 'compose', 'up', '-d', '--wait']),
      runStep('compose-ps', 'docker compose ps -a', ['docker', 'compose', 'ps', '-a']),
      // Identity is the one property a healthcheck cannot report, and it is also
      // the one this stage must not probe by guessing: `container-report` already
      // reads the image's USER (the same fact, without entering a container),
      // while compose service names are project-private — a generated pipeline
      // cannot know what the project called them, and a wrong guess would fail the
      // gate for a reason that has nothing to do with the project's code.
      // Report-only by design, and placed before teardown so the image still
      // exists while it is inspected. Its exit code is non-zero only when the
      // project configured a size limit — the other five facts are advisory.
      runStep('container-report', 'python scripts/container_report.py', [
        'uv', 'run', 'python', 'scripts/container_report.py',
      ], {
        note:
          '只报告：镜像大小、层数、默认用户是否 root、开发依赖是否泄漏、.dockerignore、多阶段构建。' +
          '只有 pyproject 里配置了 [tool.gatekeeper.image].max_size_mb 才以非零退出。',
      }),
      // `always` is a step-level fact the runners honour: the teardown must happen
      // even when the gate failed, or the next run starts on a dirty daemon.
      // Named volumes are deliberately NOT removed here: `down -v` destroys data a
      // developer may have spent the morning seeding, and the skill's own note is
      // that a stale volume is what makes this gate differ from a clean checkout —
      // clearing it is a deliberate act, not a side effect of a lint gate.
      runStep('compose-down', 'docker compose down', ['docker', 'compose', 'down'], { always: true }),
      // The clean-slate variant, kept as a commented step so `--apply`/render still
      // show it and a caller can uncomment it in a CI-only workflow.
      runStep('compose-down-volumes', 'docker compose down -v', ['docker', 'compose', 'down', '-v'], {
        commented: true,
      }),
    ],
  },
  release: {
    id: 'release',
    title: 'Release',
    job: 'release',
    needs: ['quality'],
    optional: true,
    replaces: 'semantic-release + a hand-written publish job',
    why:
      'This is the CD half, and it is where a pipeline stops being a linter with a runner. The first ' +
      'thing it does is the point of the whole stage in v0.10: it *downloads the `dist` artifact the ' +
      'quality job produced* instead of building again. A rebuild is the one step that can silently ' +
      'publish something other than what was verified — a different wheel from the same tree is still ' +
      'a different file — so attest, SBOM, the run artifact and the GitHub Release all consume the one ' +
      '`dist` that the gates already saw. That is also why the release job no longer installs uv: ' +
      'there is nothing left to build in it. Publishing to an index and pushing an image stay opt-in ' +
      'and tag-gated: they need a registry and a credential this plugin cannot verify, and a publish ' +
      'step that runs on every push either fails with no version or uploads something nobody can ' +
      'withdraw.',
    // A release is a tagged event. Without this the job would run on every push and
    // either fail or publish a pre-release nobody asked for. `workflow_dispatch` is
    // in the condition because `deploy` needs this job: a skipped `needs` skips its
    // dependant, so an urgent patch dispatched without a tag would silently never
    // deploy. On a dispatch the job stops after attaching the verified `dist` to the
    // run — every publishing step below is still tag-gated.
    if: "startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'",
    permissions: { contents: 'write', 'id-token': 'write', attestations: 'write', packages: 'write' },
    steps: [
      // The artefact hand-off. `name` must match the quality job's upload
      // (`dist`), and `path: dist` restores it exactly where `uv build` left it so
      // every later step can keep using `dist/...` paths unchanged.
      useStep('release-download', 'Download the verified distributions', 'actions/download-artifact@v4', {
        name: 'dist',
        path: 'dist',
      }),
      // The provenance and SBOM steps are what make a release auditable after the
      // fact; both are official actions with stable input names.
      useStep('release-attest', 'Attest build provenance', 'actions/attest-build-provenance@v2', {
        'subject-path': 'dist/*',
      }),
      useStep('release-sbom', 'Generate SBOM', 'anchore/sbom-action@v0', {
        path: '.',
        format: 'spdx-json',
        'artifact-name': 'sbom.spdx.json',
      }),
      // The name must differ from the quality job's `dist`: upload-artifact@v4 refuses
      // a second artifact with the same name inside one run (v3 appended to it, v4
      // fails the step with "Conflict"), and the release job is a separate job.
      useStep('release-upload', 'Attach distributions to the run', 'actions/upload-artifact@v4', {
        name: 'dist-release',
        path: 'dist/',
        'if-no-files-found': 'error',
      }),
      // Opt-in: only rendered when the caller says the project publishes a package.
      taggedStep('release-pypi', 'Publish to PyPI', 'pypa/gh-action-pypi-publish@release/v1', null, {
        optional: 'publish',
        needsEnv: 'PYPI_API_TOKEN',
        note: 'Idempotent: a version that is already on the index fails here, which is correct.',
      }),
      // Opt-in: needs a registry and a token this plugin cannot check.
      taggedStep('release-image-login', 'Log in to the registry', 'docker/login-action@v3', {
        registry: 'ghcr.io',
        username: '${{ github.actor }}',
        password: '${{ secrets.GITHUB_TOKEN }}',
      }, { optional: 'image' }),
      taggedStep('release-image-push', 'Push the image', 'docker/build-push-action@v6', {
        context: '.',
        push: 'true',
        tags: 'ghcr.io/${{ github.repository }}:${{ github.ref_name }},ghcr.io/${{ github.repository }}:latest',
      }, { optional: 'image' }),
      // Not an action: the runner's own `gh` is already authenticated, and an
      // action here would be one more moving part for the same result. A `runStep`
      // rather than a `uses`-step because there is no action to pin — the shell
      // command is the whole step.
      runStep('release-gh', 'Create the GitHub Release', [
        'gh', 'release', 'create', '${{ github.ref_name }}', 'dist/*', '--generate-notes', '--verify-tag',
      ], {
        // `--verify-tag` fails on a branch name, so this one step stays tag-only even
        // though the job itself also runs on `workflow_dispatch` (see the job `if`).
        if: "startsWith(github.ref, 'refs/tags/v')",
        // No laptop equivalent: `gh release create` publishes to the remote, and the
        // other steps of this stage are `uses:` actions the local plan already drops.
        // Without this the local plan would run a real publish from someone's machine.
        local: false,
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
      }),
    ],
  },
  deploy: {
    id: 'deploy',
    title: 'Deploy',
    job: 'deploy',
    needs: ['release'],
    optional: true,
    replaces: 'a second CD system nobody audits',
    why:
      'A deploy job is the one part of a pipeline whose content belongs to the operator, not to a ' +
      'generator: the command depends on whether the target is Kubernetes, a compose host, or a ' +
      'PaaS. So this stage renders the *frame* that is the same everywhere — an `environment:` (which ' +
      'is what gives you approvals, deployment history and a URL), a `needs:` on the release so a ' +
      'broken build cannot deploy, a tag gate, and a `workflow_dispatch` input so an urgent patch does ' +
      'not need a new tag. The command slot is a real failing step rather than a commented one: a ' +
      'generated `kubectl set image` for an infrastructure this plugin has never seen would be a guess ' +
      'wearing the authority of a template, and a deploy job that is all green while nothing was ' +
      'deployed is more dangerous than a red one because it is a false claim. Forget to replace it and ' +
      'the pipeline is red; replace it with a real command and it turns green. The smoke check is ' +
      'conditional for the same honesty: a new project with no health URL should see "skipped", not a ' +
      'failure that teaches it to ignore the deploy job.',
    if: "startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'",
    environment: 'production',
    permissions: { contents: 'read', packages: 'read' },
    steps: [
      useStep('deploy-checkout', 'Check out the released tag', 'actions/checkout@v4', {
        ref: '${{ github.ref }}',
      }),
      runStep('deploy-verify', 'Verify the released artefacts are on this commit', [
        'gh', 'release', 'view', '${{ github.ref_name }}', '--json', 'tagName,assets',
      ], {
        // Tag-gated: a dispatched deploy deploys a commit that has no GitHub Release
        // yet (that is the whole point of the escape hatch), so this step is skipped
        // rather than failing on a record that cannot exist.
        if: "startsWith(github.ref, 'refs/tags/v')",
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
        // `gh release view` asks the remote whether this tag was published. There is
        // no laptop equivalent, so the local plan drops it rather than failing on a
        // missing GH_TOKEN.
        local: false,
      }),
      // The operator's own command. It fails on purpose until replaced: the point
      // of `verified: false` is that this plugin cannot prove a deploy happened, so
      // it must not pretend. `runs` is the multi-line shell block the renderer
      // emits; there is no argv because a shell block is not an argv list. `run`
      // repeats both lines as one shell line so a renderer that only knows `run`
      // still emits a step that fails, not an `echo` that passes.
      runStep('deploy-run', 'Deploy (your command)', [], {
        run: 'echo "::error::部署命令未配置：把本步替换成你的部署命令"; exit 1',
        runs: [
          'echo "::error::部署命令未配置：把本步替换成你的部署命令"',
          'exit 1',
        ],
        verified: false,
        local: false,
        note:
          '替换为你的部署命令（kubectl set image / docker compose pull && up -d / flyctl deploy ...）。' +
          '未替换即 exit 1：部署 job 全绿却什么都没部署，比红更危险。',
      }),
      // A probe against the deployed target: meaningful only after a deploy, and a
      // local run never performed one. The `if` keeps an unconfigured project from
      // going red on day one; the step then reports "skipped", which is the truth.
      runStep('deploy-smoke', 'Smoke-check the deployed target', [
        'curl', '-fsS', '--retry', '5', '--retry-delay', '3', '${{ vars.DEPLOY_HEALTH_URL }}',
      ], {
        if: "vars.DEPLOY_HEALTH_URL != ''",
        note: '设置仓库变量 DEPLOY_HEALTH_URL 后本步才执行；未设置时显示 skipped 而不是失败。',
        local: false,
      }),
    ],
  },
}

/** Canonical order: a subset keeps this order regardless of how it was passed. */
export const STAGE_IDS = [
  'lock',
  'sync',
  'lint',
  'type',
  'manifest',
  'test',
  'security',
  'build',
  'integration',
  'audit',
  'container',
  'release',
  'deploy',
]

/**
 * The eight stages `all` means: everything a push is measured against.
 *
 * Derived rather than written out, because `optional: true` is the fact that
 * decides it — a stage that gains a daemon requirement becomes opt-in in one
 * place and stops appearing in the default run everywhere.
 */
export const DEFAULT_STAGE_IDS = STAGE_IDS.filter((id) => STAGE_CATALOG[id].optional !== true)

/**
 * The five stages that are never in `all`: two slower/networked gates and the
 * three delivery steps.
 *
 * Literal because it is a contract the panel, the documentation and the smoke
 * test all read, and because it must agree with the `optional: true` flags above
 * while `DEFAULT_STAGE_IDS` already shows the complement.
 */
export const OPTIONAL_STAGE_IDS = ['integration', 'audit', 'container', 'release', 'deploy']

/**
 * What a `git commit` runs — the fast subset, in the order the hook runs it.
 *
 * `security` is deliberately absent even though the commit hook does scan for
 * secrets: that scan needs the *staged* file set, and `scripts/ci.py` has no
 * notion of staged files — it runs whole-project argv. The hook therefore gets
 * its staged scan from a separate pre-commit entry that calls
 * `scripts/secret_scan.py --staged` directly, which is why this list is three
 * stages and not four. `type`, `test` and `build` belong to the manual full run
 * and CI: a commit must not wait for them, or the hook gets bypassed with
 * `--no-verify` and then protects nothing.
 */
export const COMMIT_STAGE_IDS = ['lock', 'lint', 'manifest']

/**
 * Job order in the rendered workflow.
 *
 * Everything cheap shares one job so the checkout and `uv sync` happen once; the
 * stages that need a daemon or a registry get their own job behind `needs`, so a
 * container failure cannot be mistaken for a lint failure. `release` then `deploy`
 * is the CD chain: download and attest, then ship, in that order, because deploying
 * something that was never attested is the failure this ordering prevents.
 */
export const JOB_ORDER = ['quality', 'container', 'release', 'deploy']

/** The shell form of an argv list. Every renderer joins the same way. */
export function runOf(argv) {
  return argv.join(' ')
}

/**
 * Which stages the pre-0.6 options select. Kept so `py-ci-render` keeps its
 * existing behavior when the caller does not pass `stages`.
 *
 * The delivery stages never enter through this door — pre-0.6 callers cannot have
 * asked for a container job, and `release` and `deploy` write to a registry and to
 * a live environment. A generator must not start deploying because someone kept an
 * old option object. `audit` is excluded for a different reason: it is a network
 * lookup that the old `security` stage used to perform inline, and promoting it to
 * its own opt-in stage must not make old callers start depending on OSV.
 *
 * @param includeSecurity - the secret scan is opt-out.
 * @param includeIntegration - the integration stage is opt-in.
 */
export function legacyStageIds(includeSecurity = true, includeIntegration = false) {
  const ids = new Set(DEFAULT_STAGE_IDS)
  if (includeSecurity !== true) ids.delete('security')
  if (includeIntegration === true) ids.add('integration')
  return STAGE_IDS.filter((id) => ids.has(id))
}

/**
 * Accept `['lint','test']` or `'lint,test'`, drop unknown ids, and return the
 * survivors in canonical order.
 *
 * `all` expands to {@link DEFAULT_STAGE_IDS} — the eight, never the delivery
 * stages: "run everything" must not mean "deploy".
 *
 * @returns `{ ids, rejected }` — rejected ids are reported, never silently applied.
 */
export function parseStageList(value) {
  if (value === undefined || value === null) return { ids: [], rejected: [] }
  const parts = Array.isArray(value) ? value : String(value).split(',')
  const ids = []
  const rejected = []
  for (const part of parts) {
    const id = String(part ?? '').trim().toLowerCase()
    if (id === '') continue
    if (id === 'all') {
      for (const stageId of DEFAULT_STAGE_IDS) if (!ids.includes(stageId)) ids.push(stageId)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(STAGE_CATALOG, id)) {
      if (!rejected.includes(id)) rejected.push(id)
      continue
    }
    if (!ids.includes(id)) ids.push(id)
  }
  return { ids: STAGE_IDS.filter((id) => ids.includes(id)), rejected }
}

/**
 * Materialize stages for a renderer or a runner.
 *
 * Deep-copied so a caller cannot mutate the catalog; `run` is precomputed so
 * renderers never disagree about how an argv list is spelled.
 *
 * A step that carries `optional: '<name>'` is dropped unless `optIn` names it. That
 * is the mechanism behind the two steps this plugin must never emit on its own —
 * publishing to PyPI and pushing an image both need a registry and a credential it
 * cannot verify — while the stages around them still render in full.
 *
 * @param ids - stage ids, canonical order enforced.
 * @param optIn - optional step names to include, e.g. `['publish', 'image']`.
 */
export function resolveStages(ids, optIn = []) {
  const wanted = new Set(ids)
  const enabled = new Set(optIn)
  return STAGE_IDS.filter((id) => wanted.has(id)).map((id) => {
    const stage = STAGE_CATALOG[id]
    return {
      ...stage,
      steps: stage.steps
        .filter((step) => step.optional === undefined || enabled.has(step.optional))
        .map((step) => {
          if (step.kind === 'uses') {
            // An action has no argv: `uses` + `with` is the whole step. `run` stays a
            // display string so the panel and the local plan can still print one line,
            // and `argv: []` marks it as not runnable locally.
            return { ...step, argv: [], run: step.uses }
          }
          const argv = step.argv ?? []
          return { ...step, argv: [...argv], run: step.run ?? runOf(argv) }
        }),
    }
  })
}

/** Resolve one `{field}` template entry against the resolved project values. */
function expandTemplate(template, resolved) {
  const argv = []
  for (const token of template) {
    const match = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(token)
    if (match === null) {
      argv.push(token)
      continue
    }
    const entry = resolved[match[1]]
    const value = entry !== null && typeof entry === 'object' && 'value' in entry ? entry.value : entry
    if (Array.isArray(value)) {
      for (const item of value) argv.push(String(item))
      continue
    }
    if (value === undefined || value === null) {
      // Leave the token visible instead of dropping it: `mypy` with no paths
      // type-checks the working directory, which is a silent wrong answer, while
      // `mypy {typePaths}` in a failure is a bug report.
      argv.push(token)
      continue
    }
    argv.push(String(value))
  }
  return argv
}

/**
 * Apply the project's resolved values to a stage's argv templates.
 *
 * This is the one implementation of the `step.by`/`step.argvBy` convention, used
 * by both renderers so the local plan and the workflow cannot spell the same
 * command two ways. Call it on `resolveStages(...)` output (or on a catalog
 * stage); stages without resolver-driven steps pass through unchanged.
 *
 * A step whose `by` field has no matching variant, or whose `resolved` entry is
 * missing, keeps its catalog argv — the fallback documented on the stage. That is
 * intentional for a half-known *value* (an unknown checker, an unnamed build
 * mode): running the documented fallback is honest, guessing would not be. An
 * *absent capability* is different and is handled before that loop — a project
 * with no sources, no tests, or no integration tests gets one visible skip step,
 * because a guessed
 * command would either fail at the tool's discretion or, worse, pass silently and
 * make "the gate never ran" indistinguishable from "the gate is green".
 *
 * @param stage - one stage from {@link STAGE_CATALOG} or {@link resolveStages}.
 * @param resolved - `resolveProject(...)` output (`{ field: { value, source } }`)
 *   or a plain `{ field: value }` map.
 */
export function applyResolved(stage, resolved = {}) {
  // Empty-project semantics live here, in the IR, so the local plan and the
  // workflow skip for the same reason and print the same sentence. A skip is a
  // visible echo plus exit 0 on purpose: a silent pass is the one outcome this
  // plugin exists to prevent, and an absent gate must never look like a green one.
  if (stage.id === 'type' && !hasItems(valueOf(resolved, 'typePaths'))) {
    return {
      ...stage,
      steps: [skipStep('type-skip', 'type check (no sources)', 'no Python sources found; type check skipped (add src/ to enable)')],
    }
  }
  if (stage.id === 'test' && valueOf(resolved, 'hasTests') === false) {
    return {
      ...stage,
      steps: [skipStep('test-skip', 'test (no tests)', 'no tests found; test gate skipped (add tests/ to enable)')],
    }
  }
  if (stage.id === 'integration' && valueOf(resolved, 'hasIntegrationTests') === false) {
    return {
      ...stage,
      steps: [skipStep('integration-skip', 'integration tests (none)', 'no integration tests found; nothing to run')],
    }
  }
  const steps = stage.steps.map((step) => {
    const by = step.by
    const variants = step.argvBy
    if (by === undefined || variants === undefined || variants === null) {
      return { ...step, argv: [...(step.argv ?? [])] }
    }
    const value = valueOf(resolved, by)
    // `buildMode` names the shape, not the variant key: workspace and package are
    // the two legal answers, and anything else (a wrapper, a typo) falls back to
    // the single-package form rather than to `--all-packages`, which is the one
    // argv that fails outside a workspace. `all-packages` is accepted as the
    // workspace spelling because `resolveProject` still ships that value; renaming
    // the consumer and the producer together is a later change, not a reason for a
    // workspace to build as if it had one package.
    const isWorkspace = value === 'workspace' || value === 'all-packages'
    const template = stage.id === 'build' && by === 'buildMode'
      ? variants[isWorkspace ? 'workspace' : 'package']
      : variants[value]
    if (!Array.isArray(template)) {
      return { ...step, argv: [...(step.argv ?? [])] }
    }
    const argv = expandTemplate(template, resolved)
    return { ...step, argv, run: runOf(argv) }
  })
  return { ...stage, steps }
}

/** True for a non-empty array — the shape `typePaths` must have to run a checker. */
function hasItems(value) {
  return Array.isArray(value) && value.length > 0
}

/** Read one entry from `resolveProject` output, unwrapping `{ value, source }`. */
function valueOf(resolved, field) {
  const entry = resolved[field]
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'value' in entry
    ? entry.value
    : entry
}

/**
 * A stage with nothing to check still reports itself: one echoed line, exit 0.
 *
 * `runs` (not `argv`) because the payload is a message, not a program to spawn —
 * the workflow renders it as `run:`, so the CI log says why the gate did not run.
 * `local: true` keeps the stage in the local plan instead of demoting it to
 * "[CI only, no local steps]", which would read as "this project has no type gate
 * at all" rather than "there is nothing to type-check yet".
 */
function skipStep(id, label, message) {
  return { id, label, kind: 'run', runs: [`echo "${message}"`], verified: true, local: true }
}

/**
 * Group resolved stages into jobs.
 *
 * A stage without a `job` belongs to the shared `quality` job; a stage that names
 * one gets its own job with the `needs` it declares. This is why the IR carries
 * `job` and `needs` at all: the renderer needs to know where a stage lives, and
 * that is a property of the stage, not of GitHub.
 *
 * @param stages - output of {@link resolveStages}.
 * @returns one entry per job, in {@link JOB_ORDER}, empty jobs dropped.
 */
export function groupJobs(stages) {
  const jobs = []
  for (const name of JOB_ORDER) {
    const members = stages.filter((stage) => (stage.job ?? 'quality') === name)
    if (members.length === 0) continue
    const needs = []
    for (const stage of members) {
      for (const need of stage.needs ?? []) if (!needs.includes(need)) needs.push(need)
    }
    // A job that needs itself would be a cycle; the IR never declares one, but a
    // future stage entry could, and a cycle is a nonsensical render.
    jobs.push({ name, needs: needs.filter((need) => need !== name), stages: members })
  }
  return jobs
}

/**
 * The stage matrix the panel and `/status` show.
 *
 * @returns one row per stage: what it is, whether it is verified, whether `all`
 *   includes it, which half of the pipeline it belongs to, and which job it
 *   renders into.
 */
export function stageMatrix() {
  return STAGE_IDS.map((id) => {
    const stage = STAGE_CATALOG[id]
    const optional = stage.optional === true
    return {
      id,
      title: stage.title,
      defaultIncluded: !optional,
      // `optional` and `kind` are the same fact read two ways, and both are on the
      // row because the panel shows a toggle ("include it?") while a reader needs
      // the noun ("this is a delivery step, not a gate"). `gate` is the eight a
      // push is measured against; `delivery` is the five that need a daemon, a
      // registry, a network, or a live environment.
      optional,
      kind: optional ? 'delivery' : 'gate',
      verified: stage.steps.every((step) => step.verified !== false),
      job: stage.job ?? 'quality',
      needs: [...(stage.needs ?? [])],
      // A `uses` step has no argv — `uses` is the whole command. Printing a blank
      // row for it in the panel would look like a bug, so the display string is the
      // action reference itself. A run step that declares its own shell form wins
      // over `runOf(argv)`: that is the one place where joining argv would print a
      // command the shell cannot actually run.
      commands: stage.steps.map((step) => {
        if (step.kind === 'uses') return step.uses
        return step.run ?? runOf(step.argv ?? [])
      }),
      // The one step a release/container reader must see first: whether the
      // pipeline can prove it, or only prepare it.
      unverified: stage.steps
        .filter((step) => step.verified === false)
        .map((step) => step.id),
    }
  })
}
