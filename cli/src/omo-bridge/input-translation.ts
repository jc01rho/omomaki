// Text-only input translation for the omo turn/start wire protocol.
//
// The wire type for turn/start input declares five item variants
// (text | image | localImage | skill | mention), but the installed
// runtime's parseInput only accepts `text` items and rejects everything
// else with -32602. This module translates richer Discord-side inputs
// (text + image attachments + skill + mentions) into the single text
// item the runtime actually accepts, and provides a guard that mirrors
// the runtime's own validation so mismatches are caught before the
// wire call is made.

export type TextInputItem = { type: 'text'; text: string }

function assertAbsoluteNoDotDot(path: string): void {
  if (!path.startsWith('/')) {
    throw new TypeError(`path must be absolute: ${path}`)
  }
  const segments = path.split('/')
  if (segments.includes('..')) {
    throw new TypeError(`path must not contain '..' segments: ${path}`)
  }
}

export function assertTextOnlyInput(
  items: readonly { type: string; text?: string }[],
): void {
  if (items.length === 0) {
    throw new TypeError('input must include at least one text item')
  }

  for (const item of items) {
    if (item.type !== 'text') {
      throw new TypeError(`unsupported input item type ${item.type}`)
    }
  }

  const hasNonEmptyText = items.some(
    (item) => typeof item.text === 'string' && item.text.trim().length > 0,
  )

  if (!hasNonEmptyText) {
    throw new TypeError('text input must not be empty')
  }
}

export function toTextInput(text: string): readonly [TextInputItem] {
  if (text.trim().length === 0) {
    throw new TypeError('text input must not be empty')
  }
  return [{ type: 'text', text }]
}

export function describeImageAttachment(canonicalPaths: readonly string[]): string {
  for (const path of canonicalPaths) {
    assertAbsoluteNoDotDot(path)
  }
  const lines = ['Attached image files:', ...canonicalPaths.map((path) => `- ${path}`)]
  return lines.join('\n')
}

export function describeSkillInvocation(skillName: string, skillPath: string): string {
  assertAbsoluteNoDotDot(skillPath)
  return `Use the skill "${skillName}" located at ${skillPath}.`
}

export function describeMention(name: string, path: string): string {
  assertAbsoluteNoDotDot(path)
  return `See ${name} at ${path}.`
}

export function translateDiscordTurnInput(opts: {
  text: string
  imagePaths?: readonly string[]
  skill?: { name: string; path: string }
  mentions?: readonly { name: string; path: string }[]
}): readonly [TextInputItem] {
  const blocks: string[] = [opts.text]

  if (opts.imagePaths && opts.imagePaths.length > 0) {
    blocks.push(describeImageAttachment(opts.imagePaths))
  }

  if (opts.skill) {
    blocks.push(describeSkillInvocation(opts.skill.name, opts.skill.path))
  }

  if (opts.mentions && opts.mentions.length > 0) {
    blocks.push(opts.mentions.map((mention) => describeMention(mention.name, mention.path)).join('\n'))
  }

  const text = blocks.join('\n\n')
  const result = toTextInput(text)
  assertTextOnlyInput(result)
  return result
}
