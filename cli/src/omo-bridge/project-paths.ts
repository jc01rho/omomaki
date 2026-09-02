// Project-root guard for omo-bridge cwd inputs.
//
// omomaki lets callers point a thread's cwd at an arbitrary path; this
// module is the single choke point that rejects anything outside the
// configured project roots before it ever reaches OmoRpcClient.
// Every check is done on realpath'd (symlink-resolved) paths so a symlink
// inside an allowed root cannot be used to escape it, and raw paths that
// spell out a '..' segment are rejected outright regardless of where they
// resolve.

import fs from 'node:fs'
import path from 'node:path'

export function isProjectRootsEnforced(
  projectRoots: readonly string[],
): boolean {
  return projectRoots.length > 0
}

function hasDotDotSegment(rawPath: string): boolean {
  return rawPath.split(path.sep).includes('..')
}

function isInsideRoot(candidateRealPath: string, rootRealPath: string): boolean {
  if (candidateRealPath === rootRealPath) return true
  const rootWithSep = rootRealPath.endsWith(path.sep)
    ? rootRealPath
    : rootRealPath + path.sep
  return candidateRealPath.startsWith(rootWithSep)
}

/**
 * Resolves `rawPath` to its real, symlink-free path and verifies it falls
 * inside at least one of `projectRoots`. Throws
 * `Error('project-path-rejected:' + rawPath)` when:
 * - `rawPath` contains a literal '..' segment,
 * - `projectRoots` is empty (nothing is allowed),
 * - the realpath'd result is outside every realpath'd root (including via
 *   a symlink that resolves outside an otherwise-matching root).
 */
export function canonicalizeProjectPath(
  rawPath: string,
  projectRoots: readonly string[],
): string {
  if (hasDotDotSegment(rawPath)) {
    throw new Error('project-path-rejected:' + rawPath)
  }

  if (!isProjectRootsEnforced(projectRoots)) {
    throw new Error('project-path-rejected:' + rawPath)
  }

  let realPath: string
  try {
    realPath = fs.realpathSync(rawPath)
  } catch (error) {
    throw new Error(
      'project-path-rejected:' + rawPath + ' (' + String(error) + ')',
    )
  }

  for (const root of projectRoots) {
    let realRoot: string
    try {
      realRoot = fs.realpathSync(root)
    } catch {
      continue
    }
    if (isInsideRoot(realPath, realRoot)) {
      return realPath
    }
  }

  throw new Error('project-path-rejected:' + rawPath)
}
