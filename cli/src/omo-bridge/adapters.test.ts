import { describe, expect, test } from 'vitest'
import {
  buildThreadForkParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnInterruptParams,
  buildTurnStartParams,
} from './adapters.js'

describe('thread param builders enforce approval policy', () => {
  test('buildThreadStartParams always sends on-request/user', () => {
    const params = buildThreadStartParams({ cwd: '/abs/path' })
    expect(params.approvalPolicy).toBe('on-request')
    expect(params.approvalsReviewer).toBe('user')
    expect(params.cwd).toBe('/abs/path')
  })

  test('buildThreadStartParams passes through model when given', () => {
    const params = buildThreadStartParams({ cwd: '/abs/path', model: 'gpt-5' })
    expect(params.model).toBe('gpt-5')
  })

  test('buildThreadStartParams rejects relative cwd', () => {
    expect(() => buildThreadStartParams({ cwd: 'relative/path' })).toThrow(
      /absolute/,
    )
  })

  test('buildThreadResumeParams always sends on-request/user', () => {
    const params = buildThreadResumeParams({ threadId: 't1' })
    expect(params.approvalPolicy).toBe('on-request')
    expect(params.approvalsReviewer).toBe('user')
    expect(params.threadId).toBe('t1')
  })

  test('buildThreadResumeParams rejects relative cwd', () => {
    expect(() =>
      buildThreadResumeParams({ threadId: 't1', cwd: 'relative/path' }),
    ).toThrow(/absolute/)
  })

  test('buildThreadForkParams always sends on-request/user', () => {
    const params = buildThreadForkParams({ threadId: 't1' })
    expect(params.approvalPolicy).toBe('on-request')
    expect(params.approvalsReviewer).toBe('user')
    expect(params.threadId).toBe('t1')
  })

  test('buildThreadForkParams rejects relative cwd', () => {
    expect(() =>
      buildThreadForkParams({ threadId: 't1', cwd: 'relative/path' }),
    ).toThrow(/absolute/)
  })
})

describe('buildTurnStartParams', () => {
  test('produces exactly one text input item', () => {
    const params = buildTurnStartParams({
      threadId: 't1',
      text: 'hello',
      clientUserMessageId: 'msg-1',
    })
    expect(params.input).toHaveLength(1)
    expect(params.input[0]?.type).toBe('text')
    expect(params.input[0]?.text).toContain('hello')
  })

  test('folds image/skill/mention into the single text item', () => {
    const params = buildTurnStartParams({
      threadId: 't1',
      text: 'hello',
      clientUserMessageId: 'msg-1',
      imagePaths: ['/tmp/a.png'],
      skill: { name: 'sk', path: '/tmp/skill' },
      mentions: [{ name: 'file.ts', path: '/tmp/file.ts' }],
    })
    expect(params.input).toHaveLength(1)
    expect(params.input[0]?.type).toBe('text')
  })

  test('passes clientUserMessageId through unchanged', () => {
    const params = buildTurnStartParams({
      threadId: 't1',
      text: 'hello',
      clientUserMessageId: 'msg-abc-123',
    })
    expect(params.clientUserMessageId).toBe('msg-abc-123')
  })

  test('rejects empty clientUserMessageId', () => {
    expect(() =>
      buildTurnStartParams({
        threadId: 't1',
        text: 'hello',
        clientUserMessageId: '',
      }),
    ).toThrow(/clientUserMessageId/)
  })

  test('threadId passes through unchanged', () => {
    const params = buildTurnStartParams({
      threadId: 'thread-xyz',
      text: 'hello',
      clientUserMessageId: 'msg-1',
    })
    expect(params.threadId).toBe('thread-xyz')
  })
})

describe('buildTurnInterruptParams', () => {
  test('passes threadId and turnId through unchanged', () => {
    const params = buildTurnInterruptParams('thread-1', 'turn-2')
    expect(params).toEqual({ threadId: 'thread-1', turnId: 'turn-2' })
  })
})
