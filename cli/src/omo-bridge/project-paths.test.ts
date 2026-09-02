// Unit tests for the project-root guard. Uses real temp directories and
// real symlinks (fs.realpathSync semantics only make sense against real
// filesystem entries) — no fixed sleeps, everything here is synchronous.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  canonicalizeProjectPath,
  isProjectRootsEnforced,
} from './project-paths.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-project-paths-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('isProjectRootsEnforced', () => {
  test('true when at least one root is configured', () => {
    expect(isProjectRootsEnforced(['/some/root'])).toBe(true)
  })

  test('false for an empty roots list', () => {
    expect(isProjectRootsEnforced([])).toBe(false)
  })
})

describe('canonicalizeProjectPath', () => {
  test('accepts a path inside a configured root', () => {
    const root = path.join(tmpDir, 'root')
    const inside = path.join(root, 'nested', 'file.txt')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.writeFileSync(inside, 'ok')

    const result = canonicalizeProjectPath(inside, [root])
    expect(result).toBe(fs.realpathSync(inside))
  })

  test('accepts the root path itself', () => {
    const root = path.join(tmpDir, 'root')
    fs.mkdirSync(root, { recursive: true })

    const result = canonicalizeProjectPath(root, [root])
    expect(result).toBe(fs.realpathSync(root))
  })

  test('rejects a raw path containing a ".." segment even if it stays inside a root', () => {
    const root = path.join(tmpDir, 'root')
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    // Raw string with a literal '..' segment - path.join would normalize it away
    // before canonicalizeProjectPath could see it.
    const dotDotPath = root + '/a/b/../b'

    expect(() => canonicalizeProjectPath(dotDotPath, [root])).toThrow(
      /^project-path-rejected:/,
    )
  })

  test('rejects a path outside every configured root', () => {
    const root = path.join(tmpDir, 'root')
    const outside = path.join(tmpDir, 'outside')
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })

    expect(() => canonicalizeProjectPath(outside, [root])).toThrow(
      'project-path-rejected:' + outside,
    )
  })

  test('rejects a symlink inside the root that resolves outside it', () => {
    const root = path.join(tmpDir, 'root')
    const outside = path.join(tmpDir, 'outside')
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')

    const escapeLink = path.join(root, 'escape')
    fs.symlinkSync(outside, escapeLink)

    expect(() =>
      canonicalizeProjectPath(path.join(escapeLink, 'secret.txt'), [root]),
    ).toThrow(/^project-path-rejected:/)
  })

  test('empty roots rejects everything, including paths that would otherwise be valid', () => {
    const root = path.join(tmpDir, 'root')
    fs.mkdirSync(root, { recursive: true })

    expect(() => canonicalizeProjectPath(root, [])).toThrow(
      'project-path-rejected:' + root,
    )
  })
})
