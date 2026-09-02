import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

export function attachJsonlLineReader(
  stream: Readable | NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)

    // Split on \n and process complete lines
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      let line = buffer.substring(0, index)
      buffer = buffer.substring(index + 1)
      index = buffer.indexOf('\n')

      // Strip optional trailing \r
      if (line.endsWith('\r')) {
        line = line.substring(0, line.length - 1)
      }

      onLine(line)
    }
  }

  const onEnd = () => {
    // Flush any remaining data in the decoder
    const final = decoder.end()
    buffer += final

    // Process any remaining data as a line
    if (buffer.length > 0) {
      let line = buffer
      // Strip optional trailing \r
      if (line.endsWith('\r')) {
        line = line.substring(0, line.length - 1)
      }
      if (line.length > 0) {
        onLine(line)
      }
    }
  }

  stream.on('data', onData)
  stream.on('end', onEnd)

  // Return unsubscribe function
  return () => {
    stream.removeListener('data', onData)
    stream.removeListener('end', onEnd)
  }
}
