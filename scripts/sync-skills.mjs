// Re-copy the skill snapshots from the upstream directory.
//
//   node scripts/sync-skills.mjs --from "../my-skills/项目管理"
//   node scripts/sync-skills.mjs --from <dir> --dry-run
//
// The list below is intentional: this is a snapshot with a known shape, not a
// mirror. Copying whatever happens to be in the source directory is how a 113 KiB
// logo and three Chinese explainers end up inside a tool plugin.
//
// Four documents in `skills/` are NOT in this list and must never be added to it:
// `ci-container-validation/`, `ci-pipeline-shape/`, `ci-release/` and `ci-deploy/`
// were written for this plugin (the upstream skills stop at "run the tests").
// Because this script only ever writes the destinations named in FILES, a re-sync
// leaves them untouched — which is the reason to keep it a list rather than a
// directory walk.

import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `[source, destination]`, both relative to their respective roots. */
const FILES = [
  ['1-uv/SKILL.md', 'uv/SKILL.md'],
  ['2-modern-python/SKILL.md', 'modern-python/SKILL.md'],
  ['2-modern-python/references/uv-commands.md', 'modern-python/references/uv-commands.md'],
  ['2-modern-python/references/pyproject.md', 'modern-python/references/pyproject.md'],
  ['2-modern-python/references/ruff-config.md', 'modern-python/references/ruff-config.md'],
  ['2-modern-python/references/testing.md', 'modern-python/references/testing.md'],
  ['2-modern-python/references/migration-checklist.md', 'modern-python/references/migration-checklist.md'],
  ['2-modern-python/references/pep723-scripts.md', 'modern-python/references/pep723-scripts.md'],
  ['2-modern-python/references/prek.md', 'modern-python/references/prek.md'],
  ['2-modern-python/references/dependabot.md', 'modern-python/references/dependabot.md'],
  ['2-modern-python/references/security-setup.md', 'modern-python/references/security-setup.md'],
  // The two modern-python/templates/* files are deliberately absent from this list:
  // they are rendered by lib/prek.js renderPreCommitConfig() and by lib/dependabot.js
  // renderDependabotConfig(), not vendored from upstream (see skills/VERSIONS.md).
  // Copying the upstream snapshots here would restore the old Yelp hook file.
  ['3-ci-cd-and-automation/SKILL.md', 'ci-cd-and-automation/SKILL.md'],
  ['4-github-actions-templates/SKILL.md', 'github-actions-templates/SKILL.md'],
]

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skillsRoot = join(packageRoot, 'skills')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const from = argument('--from')
const dryRun = process.argv.includes('--dry-run')

if (from === undefined) {
  console.error('usage: node scripts/sync-skills.mjs --from <upstream-skills-dir> [--dry-run]')
  process.exit(2)
}

const sourceRoot = resolve(from)
try {
  const info = await stat(sourceRoot)
  if (!info.isDirectory()) throw new Error('not a directory')
} catch (error) {
  console.error('sync-skills: cannot read ' + sourceRoot + ' — ' + String(error?.message ?? error))
  process.exit(1)
}

let copied = 0
let missing = 0
for (const [source, destination] of FILES) {
  const sourcePath = join(sourceRoot, source)
  const destinationPath = join(skillsRoot, destination)
  try {
    const info = await stat(sourcePath)
    if (!info.isFile()) throw new Error('not a regular file')
    if (dryRun !== true) {
      await mkdir(dirname(destinationPath), { recursive: true })
      await copyFile(sourcePath, destinationPath)
    }
    copied += 1
    console.log('  ' + (dryRun === true ? 'would copy' : 'copied') + '  ' + destination + '  (' + info.size + 'B)')
  } catch (error) {
    missing += 1
    console.error('  MISSING  ' + source + ' — ' + String(error?.message ?? error))
  }
}

console.log('')
console.log((dryRun === true ? 'would copy ' : 'copied ') + copied + ' file(s), ' + missing + ' missing')
if (missing > 0) {
  console.error('sync-skills: the source is incomplete; the snapshot would lose ' + missing + ' file(s)')
  process.exitCode = 1
}
