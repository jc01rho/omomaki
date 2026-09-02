import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { attachJsonlLineReader, serializeJsonLine } from './rpc-jsonl.js'

describe('rpc-jsonl', () => {
  test('serializeJsonLine uses LF only', () => {
    expect(serializeJsonLine({ type: 'ping' })).toBe('{"type":"ping"}\n')
  })

  test('does not split on U+2028 inside a JSON string', async () => {
    const lines: string[] = []
    const stream = new Readable({ read() {} })
    attachJsonlLineReader(stream, (line) => {
      lines.push(line)
    })
    const payload = `{"type":"text_delta","delta":"a\u2028b"}\n{"type":"agent_settled"}\n`
    stream.push(payload)
    stream.push(null)
    await new Promise<void>((resolve) => stream.on('end', () => resolve()))
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).delta).toBe('a\u2028b')
    expect(JSON.parse(lines[1]!).type).toBe('agent_settled')
  })
})
