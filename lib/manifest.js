// Agent version manifest: probe the evidence this project really has, then render
// the two artifacts that make that evidence checkable.
//
// `release/agent_versions.json` answers "which prompt / model / skills / tools /
// harness / embedding / knowledge base / index / evaluation produced this build".
// A manifest nobody verifies is a comment, so the validator is generated from the
// same probe: the required-component list inside the script cannot drift from the
// manifest it checks, and a project that lacks a component is not asked to invent
// one just to satisfy the course example.
//
// One rule shapes every function here: a component exists because a real file
// exists. No placeholder path, no guessed model id — a manifest that claims
// evidence the repository does not have is worse than a short manifest, because
// the validator would then keep validating the claim. Components a project
// genuinely lacks stay absent, and `PROBE_SPECS` below is the complete list of
// evidence this module accepts as proof.

import { createHash } from 'node:crypto'
import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

/** Where the manifest lives, relative to the project root. */
export const MANIFEST_PATH = 'release/agent_versions.json'

/** Where the stdlib-only validator is generated, relative to the project root. */
export const VALIDATOR_PATH = 'scripts/validate_version_manifest.py'

/** The component kinds a manifest may describe, in reader order. */
export const COMPONENT_IDS = [
  'prompt',
  'chat_model',
  'skills',
  'tools',
  'harness',
  'embedding',
  'knowledge_base',
  'index',
  'evaluation',
]

/** Manifest schema version. Bumping it is a change to the artifact's contract. */
const MANIFEST_SCHEMA_VERSION = '1.0'

/** 64 KiB: big enough that a large index is never read in one allocation. */
const SHA256_CHUNK_BYTES = 64 * 1024

/** A component's version starts here; a human bumps it after reviewing a change. */
const INITIAL_VERSION_SUFFIX = '-1.0.0'

/** Directory entries that are build noise rather than component content. */
const IGNORED_DIRECTORY_NAMES = new Set(['__pycache__', 'node_modules'])

/**
 * The evidence each component must have before it is written into a manifest.
 *
 * Directory names are the cheapest evidence that does not depend on the project's
 * programming language: `prompts/`, `knowledge/`, `index/` and `eval/` mean the
 * same thing in the course project and in most agent repositories. The other
 * components carry no repository file by nature (a model id, an embedding model, a
 * harness policy), so they are only recorded when an explicit config file exists —
 * otherwise the component is absent rather than filled with `"unknown"` placeholders
 * a reader would mistake for fact.
 *
 * `dirs` allows one `*` segment (`src/* /tools`) to cover the `src/<package>/tools`
 * layout; two wildcard segments are deliberately not supported, because that turns
 * probing cost into a function of repository size.
 */
const PROBE_SPECS = [
  {
    id: 'prompt',
    dirs: ['prompts', 'prompt'],
    ext: /\.(md|txt|json|ya?ml)$/i,
    preferred: ['system.md', 'supervisor.md', 'prompt.md', 'main.md', 'base.md'],
  },
  {
    // A repository file for a model is a config, not source: only config formats
    // count, so `models/user.py` (SQLAlchemy) is never mistaken for a chat model.
    id: 'chat_model',
    dirs: ['chat_model'],
    files: [
      'chat_model.json',
      'chat_model.yaml',
      'chat_model.yml',
      'chat_model.toml',
      'config/chat_model.json',
      'config/chat_model.yaml',
      'config/chat_model.toml',
    ],
  },
  {
    id: 'skills',
    // A skill is a name the agent can invoke, not one file: the honest manifest entry
    // is the collection the project has, so this component records `items`.
    items: true,
    dirs: ['skills', 'src/*/skills'],
    ext: /\.(md|py|js|mjs|ts)$/i,
    // Meta documents describe the skill collection; they are not skills.
    ignore: /^(README|VERSIONS|CHANGELOG)\b/i,
  },
  {
    id: 'tools',
    // Same shape as skills: a tool is a callable the agent was given, and one file
    // may register several. The file stem is the only name a reviewer can cross-check
    // against the repository, so it is what the manifest records.
    items: true,
    dirs: ['tools', 'lib/tools', 'src/*/tools'],
    ext: /\.(py|js|mjs|ts)$/i,
    // A file starting with `_` is a base class or helper, not a callable tool.
    ignore: /^(_|conftest$|test_)/,
  },
  {
    id: 'harness',
    dirs: ['harness', 'src/*/harness'],
    files: [
      'harness.yaml',
      'harness.yml',
      'harness.toml',
      'config/harness.yaml',
      'config/harness.toml',
    ],
  },
  {
    id: 'embedding',
    dirs: ['embedding', 'embeddings', 'src/*/embedding'],
    files: [
      'embedding.json',
      'embedding.yaml',
      'embedding.yml',
      'config/embedding.json',
      'config/embedding.yaml',
    ],
  },
  {
    id: 'knowledge_base',
    dirs: ['knowledge', 'knowledge_base', 'kb'],
    ext: /\.(md|txt|json|ya?ml)$/i,
    preferred: ['faq.md', 'index.md', 'README.md', 'knowledge.md'],
  },
  {
    id: 'index',
    dirs: ['index', 'indexes', 'index_store'],
    ext: /\.(json|ya?ml|bin|pkl|npy|faiss|sqlite|db)$/i,
    preferred: ['index_manifest.json', 'manifest.json', 'index.json', 'mappings.json'],
  },
  {
    id: 'evaluation',
    dirs: ['eval', 'evals', 'evaluation', 'src/*/eval'],
    ext: /\.(json|jsonl|ya?ml|csv)$/i,
    preferred: ['eval_cases.json', 'eval_cases.jsonl', 'eval_cases.yaml', 'cases.json'],
  },
]

/**
 * What a manifest entry for one component looks like.
 *
 * The shape mirrors the course manifest: `version` always, `items` for a component
 * that is a collection of names (skills, tools), `path` + `sha256` for a component
 * that is backed by one file. A component with no file gets no `path`/`sha256` —
 * not a fake one — and the validator only demands the pair when a path is present.
 */
function initialVersion(componentId) {
  return componentId + INITIAL_VERSION_SUFFIX
}

/** A directory listing, or `null` when the path is missing / not a directory. */
function readDir(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    return null
  }
}

/** Whether an entry name is build noise rather than component content. */
function isIgnoredName(name) {
  return name.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(name)
}

/**
 * Whether `child` is inside `parent`.
 *
 * `path.relative` is used instead of a string prefix so `..foo` (a legal file name)
 * cannot be mistaken for a parent directory, and the comparison runs on resolved
 * paths so a symlink pointing outside the project is caught before its file is
 * written into a manifest the validator would then reject.
 */
function isInside(parent, child) {
  const relative = path.relative(parent, child)
  if (relative === '' || path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith('..' + path.sep)
}

/** A project-relative path written with `/`, so manifests are identical on every OS. */
function toPosixRelative(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/** Expand a candidate directory pattern; at most one `*` segment is supported. */
function candidateDirectories(root, patterns) {
  const found = []
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    if (typeof pattern !== 'string' || pattern.trim() === '') continue
    if (!pattern.includes('*')) {
      found.push(toPosixRelative(pattern))
      continue
    }
    const pieces = pattern.split('*')
    if (pieces.length !== 2) continue
    const base = toPosixRelative(pieces[0]).replace(/\/+$/, '')
    const tail = toPosixRelative(pieces[1]).replace(/^\/+/, '')
    if (base === '') continue
    const entries = readDir(path.join(root, ...base.split('/')))
    if (entries === null) continue
    for (const entry of entries) {
      if (!entry.isDirectory() || isIgnoredName(entry.name)) continue
      found.push(tail === ''
        ? path.posix.join(base, entry.name)
        : path.posix.join(base, entry.name, tail))
    }
  }
  return found
}

/**
 * The best single file inside a component directory.
 *
 * Preference order is: a name from `preferred` (the course layout puts the
 * authoritative file at a known name), then the alphabetically first match, then
 * one level of nesting (`index/faiss/chunks.bin`). Deterministic, because the same
 * probe must yield the same manifest twice in a row.
 */
function pickFile(root, directoryRelative, spec, depth = 0) {
  const entries = readDir(path.join(root, ...directoryRelative.split('/')))
  if (entries === null) return null

  const files = []
  const subdirectories = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!isIgnoredName(entry.name)) subdirectories.push(entry.name)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (spec.ext && !spec.ext.test(entry.name)) continue
    if (spec.ignore && spec.ignore.test(entry.name)) continue
    files.push(entry.name)
  }

  if (files.length > 0) {
    files.sort()
    const preferred = (spec.preferred ?? []).find((name) => files.includes(name))
    return path.posix.join(directoryRelative, preferred ?? files[0])
  }
  if (depth >= 2) return null
  subdirectories.sort()
  for (const name of subdirectories) {
    const nested = pickFile(root, path.posix.join(directoryRelative, name), spec, depth + 1)
    if (nested !== null) return nested
  }
  return null
}

/** Every candidate file for a component: explicit names first, then directory picks. */
function candidateFiles(root, spec) {
  const found = []
  for (const file of Array.isArray(spec.files) ? spec.files : []) {
    if (typeof file === 'string' && file.trim() !== '') found.push(toPosixRelative(file))
  }
  for (const directory of candidateDirectories(root, spec.dirs)) {
    const picked = pickFile(root, directory, spec)
    if (picked !== null) found.push(picked)
  }
  return found
}

/**
 * Accept a project-relative path only if it is a regular file inside the project.
 *
 * Both checks are load-bearing: the validator resolves the path and compares it
 * with the project root, so a symlink escaping the root would pass `statSync` here
 * and fail the gate later. Rejecting it at probe time keeps the generated manifest
 * and the generated validator in agreement.
 */
function acceptFile(root, rootReal, relative) {
  const absolute = path.join(root, ...relative.split('/'))
  let info
  try {
    info = statSync(absolute)
  } catch {
    return null
  }
  if (!info.isFile()) return null
  let real
  try {
    real = realpathSync(absolute)
  } catch {
    return null
  }
  if (!isInside(rootReal, real)) return null
  return { relative, absolute }
}

/** Whether a candidate directory resolves to a location inside the project root. */
function directoryIsInside(root, rootReal, relative) {
  try {
    return isInside(rootReal, realpathSync(path.join(root, ...relative.split('/'))))
  } catch {
    return false
  }
}

/**
 * SHA-256 of a file, read in 64 KiB blocks.
 *
 * The block size is the same one the generated validator uses, so "same algorithm"
 * is not just claimed but literally the same reading strategy on both sides.
 */
function sha256File(absolutePath) {
  const digest = createHash('sha256')
  const descriptor = openSync(absolutePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(SHA256_CHUNK_BYTES)
    let read = readSync(descriptor, buffer, 0, buffer.length, null)
    while (read > 0) {
      digest.update(buffer.subarray(0, read))
      read = readSync(descriptor, buffer, 0, buffer.length, null)
    }
  } finally {
    closeSync(descriptor)
  }
  return digest.digest('hex')
}

/** Names inside a collection component (`skills/`, `tools/`), sorted and unique. */
function listItems(root, rootReal, directoryRelative, spec) {
  if (!directoryIsInside(root, rootReal, directoryRelative)) return null
  const entries = readDir(path.join(root, ...directoryRelative.split('/')))
  if (entries === null) return null

  const items = new Set()
  for (const entry of entries) {
    if (isIgnoredName(entry.name)) continue
    if (entry.isDirectory()) {
      items.add(entry.name)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (spec.ext && !spec.ext.test(entry.name)) continue
    if (spec.ignore && spec.ignore.test(entry.name)) continue
    items.add(entry.name.replace(spec.ext, ''))
  }
  return [...items].sort()
}

/** Probe one component; `null` means the project has no evidence of it. */
function probeOne(root, rootReal, spec) {
  if (spec.items === true) {
    for (const directory of candidateDirectories(root, spec.dirs)) {
      const items = listItems(root, rootReal, directory, spec)
      if (items === null || items.length === 0) continue
      return { id: spec.id, version: initialVersion(spec.id), items }
    }
    return null
  }

  for (const relative of candidateFiles(root, spec)) {
    const accepted = acceptFile(root, rootReal, relative)
    if (accepted === null) continue
    let sha256
    try {
      sha256 = sha256File(accepted.absolute)
    } catch {
      continue
    }
    return { id: spec.id, version: initialVersion(spec.id), path: accepted.relative, sha256 }
  }
  return null
}

/**
 * The components this project really has, each with the evidence that proves it.
 *
 * `detection` is accepted because the caller already inspected the project, and its
 * `root` is a useful fallback when the tool was given only a detection result. It is
 * *not* trusted for existence: detection may be a snapshot taken before the last
 * write, and a generator that says "the project has prompts/" because a stale
 * snapshot said so would fabricate exactly the path this module refuses to invent.
 * Every returned path was stat-ed and hashed from disk during this call.
 *
 * @param options - `{ rootDir, detection }`; either may supply the project root.
 * @returns array in `COMPONENT_IDS` order; absent components are simply missing.
 */
export function probeComponents({ rootDir, detection } = {}) {
  const requested = rootDir ?? detection?.root
  const root = path.resolve(String(requested ?? '.'))
  let rootReal = root
  try {
    rootReal = realpathSync(root)
  } catch {
    // An unreadable root is not an error here: every probe below reports "no
    // evidence" on its own, which is the honest answer for a directory we cannot see.
  }

  const components = []
  for (const spec of PROBE_SPECS) {
    const component = probeOne(root, rootReal, spec)
    if (component !== null) components.push(component)
  }
  return components
}

/** A non-empty string, a finite number as text, or the fallback. */
function textOr(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return fallback
}

/** Render one manifest entry from a probed component. */
function componentEntry(component) {
  const entry = { version: textOr(component?.version, initialVersion(component.id)) }

  const items = Array.isArray(component?.items)
    ? [...new Set(component.items.filter((item) => typeof item === 'string' && item !== ''))].sort()
    : []
  if (items.length > 0) entry.items = items

  // path and sha256 are a pair in the validator: half a pair is never written, so a
  // manifest generated here can always pass the validator generated next to it.
  const filePath = textOr(component?.path, null)
  const sha256 = textOr(component?.sha256, null)
  if (filePath !== null && sha256 !== null) {
    entry.path = filePath
    entry.sha256 = sha256
  }
  return entry
}

/**
 * The manifest object for a project.
 *
 * Components are emitted in `COMPONENT_IDS` order regardless of input order, so
 * regenerating the same project twice produces byte-identical JSON and a diff
 * between two manifests means a real change rather than a reshuffle. Unknown ids are
 * dropped: the manifest schema is closed, and a typo should not become a component
 * the validator was never told about.
 *
 * Missing scalar arguments fall back to visibly placeholder values rather than
 * plausible ones — `python: "3.13"` invented here would look like a measured fact.
 *
 * @param options - `{ projectName, version, pythonVersion, uvVersion, lockfile,
 *   components }`, all optional; `components` comes from {@link probeComponents}.
 * @returns the object to serialise as `release/agent_versions.json`.
 */
export function renderManifest({
  projectName,
  version,
  pythonVersion,
  uvVersion,
  lockfile,
  components,
} = {}) {
  const byId = new Map()
  for (const component of Array.isArray(components) ? components : []) {
    if (typeof component?.id !== 'string' || !COMPONENT_IDS.includes(component.id)) continue
    if (!byId.has(component.id)) byId.set(component.id, component)
  }

  const agent = {}
  for (const id of COMPONENT_IDS) {
    const component = byId.get(id)
    if (component !== undefined) agent[id] = componentEntry(component)
  }

  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    service: {
      name: textOr(projectName, 'unknown-service'),
      version: textOr(version, '0.0.0'),
    },
    runtime: {
      python: textOr(pythonVersion, 'unknown'),
      uv: textOr(uvVersion, 'unknown'),
      lockfile: textOr(lockfile, 'uv.lock'),
    },
    agent,
  }
}

/** The `PROJECT_COMPONENTS` literal, one id per line so a diff names the component. */
function projectComponentsBlock(ids) {
  if (ids.length === 0) return 'PROJECT_COMPONENTS: list[str] = []'
  return ['PROJECT_COMPONENTS = [', ...ids.map((id) => `    ${JSON.stringify(id)},`), ']'].join('\n')
}

/**
 * The stdlib-only validator source for a project.
 *
 * Why generate it rather than ship a fixed script: the set of required components is
 * project-specific (`PROJECT_COMPONENTS`), and a fixed list of nine would fail every
 * project that has no knowledge base. Why stdlib-only: this file runs before
 * anything is installed in some jobs, and `uv run --locked` must be able to start it
 * on a machine where only Python exists.
 *
 * The script checks the eight failures the plan enumerates — bad JSON, missing
 * top-level field, missing component, unpaired/typed path+sha256, path escaping the
 * project root, missing file, digest mismatch — and exits 1 with a Chinese reason so
 * the failing gate is readable without opening the manifest. It never rewrites the
 * digest: a changed file is a decision for a human ("请审核变更后更新版本和
 * SHA-256"), which is the whole point of the gate.
 *
 * @param options - `{ components }`; ids come from {@link probeComponents}.
 * @returns Python source text, newline-terminated.
 */
export function renderValidator({ components } = {}) {
  const ids = []
  for (const component of Array.isArray(components) ? components : []) {
    const id = typeof component === 'string' ? component : component?.id
    if (typeof id !== 'string' || !COMPONENT_IDS.includes(id) || ids.includes(id)) continue
    ids.push(id)
  }
  ids.sort((left, right) => COMPONENT_IDS.indexOf(left) - COMPONENT_IDS.indexOf(right))

  const componentsBlock = projectComponentsBlock(ids)
  const manifestExpression = 'PROJECT_ROOT / '
    + MANIFEST_PATH.split('/').map((part) => JSON.stringify(part)).join(' / ')

  return `#!/usr/bin/env python3
"""校验 release/agent_versions.json：字段齐全、路径在项目根内、摘要与磁盘一致。

生成物：由 gatekeeper 的 lib/manifest.js 生成，不要手改；组件集合或摘要变化时重新生成。
仅使用标准库，可直接用 uv run --locked python scripts/validate_version_manifest.py 运行。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
# 与插件常量 MANIFEST_PATH 一致；改路径时两处一起改。
MANIFEST_PATH = ${manifestExpression}

# 本项目真实拥有的组件（生成时探测得出）。清单必须为每个组件写版本；
# 其中带 path 的组件还要通过路径与摘要检查，其余只核对是否存在。
${componentsBlock}

# 顶层四类信息，缺任何一个都说明生成流程漏了一步。
REQUIRED_TOP_LEVEL = ("schema_version", "service", "runtime", "agent")

# 分块计算摘要：索引、权重这类大文件不必整体读进内存。
SHA256_CHUNK_BYTES = 64 * 1024


class ManifestValidationError(ValueError):
    """版本清单不完整，或与仓库中的文件不一致。"""


def _sha256(file_path: Path) -> str:
    """分块计算文件摘要，避免把大文件一次性读入内存。"""

    digest = hashlib.sha256()
    with file_path.open("rb") as file:
        for block in iter(lambda: file.read(SHA256_CHUNK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def _require_mapping(value: object, field_name: str) -> dict[str, Any]:
    """把运行时类型检查集中在一处，错误信息才有统一的形状。"""

    if not isinstance(value, dict):
        raise ManifestValidationError(f"{field_name} 必须是 JSON 对象")
    return value


def validate_manifest(manifest_path: Path, project_root: Path) -> dict[str, Any]:
    """读取并校验清单；通过时返回解析后的对象。

    三件事必须同时成立，发布证据才可信：
    1. 顶层四类信息齐全，且 PROJECT_COMPONENTS 中每个组件都有版本记录；
    2. 清单引用的文件都在项目根目录内（先 resolve 再 is_relative_to，所以 ../
       和指向根外的软链接都过不去）；
    3. 文件当前摘要与清单记录一致 —— 不一致只报告，不提供自动刷新。
    """

    try:
        text = manifest_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ManifestValidationError(f"无法读取版本清单：{exc}") from exc

    try:
        raw: object = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ManifestValidationError(f"版本清单不是合法 JSON：{exc}") from exc

    manifest = _require_mapping(raw, "清单根节点")
    for key in REQUIRED_TOP_LEVEL:
        if key not in manifest:
            raise ManifestValidationError(f"缺少必填字段：{key}")

    agent = _require_mapping(manifest["agent"], "agent")
    missing = [name for name in PROJECT_COMPONENTS if name not in agent]
    if missing:
        raise ManifestValidationError("agent 缺少组件版本：" + "、".join(missing))

    root = project_root.resolve()
    for name, value in agent.items():
        # 版本型组件（模型标识、Skill 清单等）没有仓库文件可校验。
        if not isinstance(value, dict):
            continue
        has_path = "path" in value
        has_sha256 = "sha256" in value
        # 半对字段一律拒绝：只有 sha256 没有 path 时，那个摘要永远不会被核对。
        if has_path != has_sha256:
            raise ManifestValidationError(f"{name} 的 path 和 sha256 必须成对出现")
        if not has_path:
            continue
        relative_path = value.get("path")
        expected = value.get("sha256")
        if not isinstance(relative_path, str) or not isinstance(expected, str):
            raise ManifestValidationError(f"{name} 的 path 和 sha256 必须是字符串")
        candidate = (root / relative_path).resolve()
        if not candidate.is_relative_to(root):
            raise ManifestValidationError(f"{name} 的路径越过了项目根目录：{relative_path}")
        if not candidate.is_file():
            raise ManifestValidationError(f"{name} 引用的文件不存在：{relative_path}")
        if _sha256(candidate) != expected:
            raise ManifestValidationError(f"{name} 摘要不一致：请审核变更后更新版本和 SHA-256")

    return manifest


def main(argv: list[str] | None = None) -> int:
    """返回 0 表示清单可以继续往下游走，返回 1 表示发布证据不可信。"""

    parser = argparse.ArgumentParser(description="校验 Agent 版本清单")
    parser.add_argument(
        "--root",
        default=None,
        help="项目根目录，默认取脚本所在仓库的根目录",
    )
    args = parser.parse_args(argv)

    project_root = Path(args.root).resolve() if args.root else PROJECT_ROOT
    manifest_path = project_root / MANIFEST_PATH.relative_to(PROJECT_ROOT)
    try:
        manifest = validate_manifest(manifest_path, project_root)
    except ManifestValidationError as exc:
        print(f"版本清单校验失败：{exc}")
        return 1

    service = manifest["service"]
    print(f"版本清单校验通过：{service['name']} {service['version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`
}

/** Empty containers are leaves in a diff: `{}` vs `{}` is not a change. */
const EMPTY_OBJECT = Symbol('empty-object')

/** Empty array marker; kept separate so `[]` -> `{}` reads as a change. */
const EMPTY_ARRAY = Symbol('empty-array')

/** Walk a JSON value into `dotted.path[index]` -> scalar leaves. */
function flatten(value, prefix, leaves) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (prefix !== '') leaves.set(prefix, EMPTY_ARRAY)
      return
    }
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, leaves))
    return
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) {
      if (prefix !== '') leaves.set(prefix, EMPTY_OBJECT)
      return
    }
    for (const key of keys) flatten(value[key], prefix === '' ? key : `${prefix}.${key}`, leaves)
    return
  }
  if (prefix !== '') leaves.set(prefix, value)
}

/** Format a leaf for a diff line, quoting strings so whitespace is visible. */
function formatLeaf(value) {
  if (value === EMPTY_OBJECT) return '{}'
  if (value === EMPTY_ARRAY) return '[]'
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  return String(value)
}

/** Accept an already-parsed manifest, or the file text; unreadable input is empty. */
function normalizeManifest(existing) {
  if (typeof existing === 'string') {
    try {
      const parsed = JSON.parse(existing)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      // A corrupt manifest compares as "nothing known yet": every field shows up as
      // added, which is exactly the review a human has to do by hand anyway.
      return {}
    }
  }
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) return existing
  return {}
}

/**
 * What regenerating the manifest would change, for human review.
 *
 * The generator never overwrites an existing `release/agent_versions.json`: a digest
 * that moved is a prompt version that changed, and choosing to accept it is the
 * review step the gate exists for. This function only reports; whether to write is
 * the caller's decision.
 *
 * Two shapes for comparison: `dotted.path` leaves (`agent.prompt.sha256`,
 * `agent.skills.items[0]`) with `+` added, `-` removed, `~` changed. Order follows
 * the new manifest so two runs over the same pair print identical lines.
 *
 * @param existing - parsed existing manifest (or its text); `{}` when none exists.
 * @param next - a {@link renderManifest} result.
 * @returns `{ changed, lines }`; `lines` is empty exactly when `changed` is false.
 */
export function diffManifest(existing, next) {
  const before = new Map()
  const after = new Map()
  flatten(normalizeManifest(existing), '', before)
  flatten(normalizeManifest(next), '', after)

  const lines = []
  for (const [pointer, value] of after) {
    if (!before.has(pointer)) {
      lines.push(`+ ${pointer}: ${formatLeaf(value)}`)
      continue
    }
    const previous = before.get(pointer)
    if (!Object.is(previous, value)) {
      lines.push(`~ ${pointer}: ${formatLeaf(previous)} → ${formatLeaf(value)}`)
    }
  }
  for (const [pointer, value] of before) {
    if (!after.has(pointer)) lines.push(`- ${pointer}: ${formatLeaf(value)}`)
  }
  return { changed: lines.length > 0, lines }
}
