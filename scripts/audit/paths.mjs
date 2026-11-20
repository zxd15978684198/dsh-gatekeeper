// Shared path resolution for the audit probes in this directory.
//
// Everything here is derived from this file's own location or from the DSH
// environment, so the probes work from any checkout and from any profile. The
// only thing they cannot guess is where DSH keeps its profiles, so that one is
// read from the environment with a sensible default.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The plugin root (this file lives in `<root>/scripts/audit/`). */
export const pluginRoot = new URL('../../', import.meta.url)

/** Absolute path of the plugin root, without a trailing separator. */
export const pluginRootPath = pluginRoot.pathname.replace(/^\/(?=[A-Za-z]:)/, '').replace(/\/$/, '')

/** Absolute path of a file inside the plugin. */
export const pluginFile = (relative) => join(pluginRootPath, relative)

/** Absolute path of a committed fixture under `scripts/audit/fixtures/`. */
export const fixture = (name) => join(pluginRootPath, 'scripts', 'audit', 'fixtures', name)

/**
 * The DSH profile directory.
 *
 * `DSH_PROFILE_DIR` wins; otherwise `$DSH_HOME/profiles/$DSH_PROFILE`; otherwise
 * `~/.dsh/profiles/desktop`, which is where the desktop build installs.
 */
export function dshProfileDir() {
  if (process.env.DSH_PROFILE_DIR !== undefined && process.env.DSH_PROFILE_DIR !== '') {
    return process.env.DSH_PROFILE_DIR
  }
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
}

/**
 * A `file://` URL for an installed package's entry module, so it can be dynamically
 * imported from an ESM probe (a bare specifier would resolve against this package,
 * not against the profile that installed it).
 */
export function installedModuleUrl(packageName, entry) {
  const target = join(dshProfileDir(), 'node_modules', packageName, entry)
  if (existsSync(target) === false) {
    throw new Error(
      `cannot find ${packageName} in ${dshProfileDir()}; set DSH_PROFILE_DIR to the profile that has it installed`,
    )
  }
  return pathToFileURL(target).href
}

/** The schemastery that DSH itself loads, so the probe sees the real `.volatile()`. */
export const schemasteryUrl = () => installedModuleUrl('@deepseek-ai/schemastery', 'lib/index.mjs')
