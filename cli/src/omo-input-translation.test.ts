// Contract tests for the text-only input translation module.
//
// The turn/start wire type declares five input item variants
// (text | image | localImage | skill | mention), but the installed
// runtime's parseInput accepts TEXT ONLY and rejects the other four
// with -32602. These tests pin that mismatch: assertTextOnlyInput must
// reject every non-text variant with the exact runtime error messages,
// and translateDiscordTurnInput must always produce output that passes
// the guard.

import { describe, it, expect } from 'vitest'
import {
  assertTextOnlyInput,
  toTextInput,
  describeImageAttachment,
  describeSkillInvocation,
  describeMention,
  translateDiscordTurnInput,
} from './omo-bridge/input-translation.js'

describe('assertTextOnlyInput (wire declares 5 variants, runtime accepts text only)', () => {
  it('accepts a single text item', () => {
    expect(() => assertTextOnlyInput([{ type: 'text', text: 'hello' }])).not.toThrow()
  })

  it('rejects image items with exact runtime message', () => {
    expect(() => assertTextOnlyInput([{ type: 'image' }])).toThrow(
      new TypeError('unsupported input item type image'),
    )
  })

  it('rejects localImage items with exact runtime message', () => {
    expect(() => assertTextOnlyInput([{ type: 'localImage' }])).toThrow(
      new TypeError('unsupported input item type localImage'),
    )
  })

  it('rejects skill items with exact runtime message', () => {
    expect(() => assertTextOnlyInput([{ type: 'skill' }])).toThrow(
      new TypeError('unsupported input item type skill'),
    )
  })

  it('rejects mention items with exact runtime message', () => {
    expect(() => assertTextOnlyInput([{ type: 'mention' }])).toThrow(
      new TypeError('unsupported input item type mention'),
    )
  })

  it('rejects a non-text item mixed with a text item', () => {
    expect(() =>
      assertTextOnlyInput([{ type: 'text', text: 'hi' }, { type: 'image' }]),
    ).toThrow(new TypeError('unsupported input item type image'))
  })

  it('rejects empty item lists', () => {
    expect(() => assertTextOnlyInput([])).toThrow(
      new TypeError('input must include at least one text item'),
    )
  })

  it('rejects whitespace-only text items', () => {
    expect(() => assertTextOnlyInput([{ type: 'text', text: '   \n\t ' }])).toThrow(
      new TypeError('text input must not be empty'),
    )
  })
})

describe('toTextInput', () => {
  it('wraps text without trimming', () => {
    expect(toTextInput('  hello  ')).toEqual([{ type: 'text', text: '  hello  ' }])
  })

  it('rejects text that is empty after trimming', () => {
    expect(() => toTextInput('   ')).toThrow(new TypeError('text input must not be empty'))
  })

  it('rejects the empty string', () => {
    expect(() => toTextInput('')).toThrow(new TypeError('text input must not be empty'))
  })
})

describe('describeImageAttachment', () => {
  it('formats a header line and one bullet per path', () => {
    expect(describeImageAttachment(['/tmp/a.png', '/tmp/b.jpg'])).toBe(
      'Attached image files:\n- /tmp/a.png\n- /tmp/b.jpg',
    )
  })

  it('rejects non-absolute paths', () => {
    expect(() => describeImageAttachment(['relative/a.png'])).toThrow(TypeError)
  })

  it('rejects paths containing a .. segment', () => {
    expect(() => describeImageAttachment(['/tmp/../etc/passwd'])).toThrow(TypeError)
  })
})

describe('describeSkillInvocation', () => {
  it('formats the skill line', () => {
    expect(describeSkillInvocation('deploy', '/skills/deploy.md')).toBe(
      'Use the skill "deploy" located at /skills/deploy.md.',
    )
  })

  it('rejects non-absolute skill paths', () => {
    expect(() => describeSkillInvocation('deploy', 'skills/deploy.md')).toThrow(TypeError)
  })

  it('rejects skill paths containing a .. segment', () => {
    expect(() => describeSkillInvocation('deploy', '/skills/../etc/passwd')).toThrow(TypeError)
  })
})

describe('describeMention', () => {
  it('formats the mention line', () => {
    expect(describeMention('README', '/repo/README.md')).toBe('See README at /repo/README.md.')
  })

  it('rejects non-absolute mention paths', () => {
    expect(() => describeMention('README', 'repo/README.md')).toThrow(TypeError)
  })

  it('rejects mention paths containing a .. segment', () => {
    expect(() => describeMention('README', '/repo/../etc/passwd')).toThrow(TypeError)
  })
})

describe('translateDiscordTurnInput', () => {
  it('produces a single text item for plain text', () => {
    const result = translateDiscordTurnInput({ text: 'hello world' })
    expect(result).toEqual([{ type: 'text', text: 'hello world' }])
    expect(() => assertTextOnlyInput(result)).not.toThrow()
  })

  it('concatenates text, images, skill, and mentions with blank-line separation', () => {
    const result = translateDiscordTurnInput({
      text: 'please review',
      imagePaths: ['/tmp/screenshot.png'],
      skill: { name: 'review', path: '/skills/review.md' },
      mentions: [{ name: 'app.ts', path: '/repo/app.ts' }],
    })
    expect(result).toEqual([
      {
        type: 'text',
        text: [
          'please review',
          'Attached image files:\n- /tmp/screenshot.png',
          'Use the skill "review" located at /skills/review.md.',
          'See app.ts at /repo/app.ts.',
        ].join('\n\n'),
      },
    ])
    expect(() => assertTextOnlyInput(result)).not.toThrow()
  })

  it('joins multiple mentions on separate lines within one block', () => {
    const result = translateDiscordTurnInput({
      text: 'context',
      mentions: [
        { name: 'a.ts', path: '/repo/a.ts' },
        { name: 'b.ts', path: '/repo/b.ts' },
      ],
    })
    expect(result[0].text).toBe(
      'context\n\nSee a.ts at /repo/a.ts.\nSee b.ts at /repo/b.ts.',
    )
  })

  it('rejects an absolute-path violation from an image attachment', () => {
    expect(() =>
      translateDiscordTurnInput({ text: 'hi', imagePaths: ['relative.png'] }),
    ).toThrow(TypeError)
  })

  it('rejects a .. segment violation from a skill path', () => {
    expect(() =>
      translateDiscordTurnInput({
        text: 'hi',
        skill: { name: 's', path: '/skills/../etc/passwd' },
      }),
    ).toThrow(TypeError)
  })

  it('rejects empty text with no other content', () => {
    expect(() => translateDiscordTurnInput({ text: '   ' })).toThrow(
      new TypeError('text input must not be empty'),
    )
  })
})
