import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXT_PATH = path.join(__dirname, 'omomaki-approve.ts')

describe('omomaki-approve extension source', () => {
  test('is export default and does not target ~/.omo/agent/extensions', () => {
    const source = readFileSync(EXT_PATH, 'utf8')
    expect(source).toMatch(/export default function/)
    expect(source).not.toMatch(/~\/\.omo\/agent\/extensions/)
    expect(source).toMatch(/tool_call/)
    expect(source).toMatch(/ctx\.ui\.confirm/)
    expect(source).toMatch(/block:\s*true/)
  })
})
