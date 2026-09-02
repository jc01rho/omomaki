// Tests for the omomaki schema additions: omo_thread_bindings, omo_message_queue,
// security_audit. Auto-isolated via VITEST guards in config.ts (temp data dir).

import { afterAll, describe, expect, test } from 'vitest'
import { closeDb, getDb } from './db.js'
import * as orm from 'drizzle-orm'
import * as schema from './schema.js'

afterAll(async () => {
  await closeDb()
})

const REQUIRED_TABLES = [
  'omo_thread_bindings',
  'omo_message_queue',
  'security_audit',
] as const

describe('omomaki schema tables', () => {
  test('migrateSchema creates the three omomaki tables', async () => {
    const db = await getDb()
    // Use sqlite_master to assert CREATE TABLE presence (independent of drizzle relations).
    const rows = await db.all<{ name: string }>(orm.sql`
      SELECT name FROM sqlite_master WHERE type='table'
    `)
    const tableNames = rows.map((r) => r.name)
    for (const expected of REQUIRED_TABLES) {
      expect(tableNames, `expected table ${expected} to exist`).toContain(expected)
    }
  })

  test('omo_thread_bindings round-trips and enforces unique omo_thread_id', async () => {
    const db = await getDb()
    const now = new Date().toISOString()

    const [inserted] = await db.insert(schema.omo_thread_bindings)
      .values({
        discord_thread_id: 'discord-thread-1',
        omo_thread_id: 'omo-thread-A',
        session_path: '/tmp/sessions/A',
        app_server_version: '1.2.3',
        fork_parent_discord_thread_id: null,
        fork_parent_omo_thread_id: null,
        created_at: now,
        updated_at: now,
      })
      .returning()
    expect(inserted).toBeDefined()
    expect(inserted?.discord_thread_id).toBe('discord-thread-1')
    expect(inserted?.omo_thread_id).toBe('omo-thread-A')
    expect(inserted?.session_path).toBe('/tmp/sessions/A')
    expect(inserted?.app_server_version).toBe('1.2.3')
    expect(inserted?.created_at).toBe(now)
    expect(inserted?.updated_at).toBe(now)

    const found = await db.query.omo_thread_bindings.findFirst({
      where: { discord_thread_id: 'discord-thread-1' },
    })
    expect(found?.omo_thread_id).toBe('omo-thread-A')

    // Duplicate omo_thread_id must violate the UNIQUE constraint.
    await expect(
      db.insert(schema.omo_thread_bindings).values({
        discord_thread_id: 'discord-thread-2',
        omo_thread_id: 'omo-thread-A',
        session_path: null,
        app_server_version: null,
        fork_parent_discord_thread_id: null,
        fork_parent_omo_thread_id: null,
        created_at: now,
        updated_at: now,
      }),
    ).rejects.toThrow()

    // Cleanup
    await db.delete(schema.omo_thread_bindings).where(
      orm.eq(schema.omo_thread_bindings.discord_thread_id, 'discord-thread-1'),
    )
  })

  test('omo_message_queue round-trips and enforces unique client_user_message_id', async () => {
    const db = await getDb()
    const now = new Date().toISOString()

    const [inserted] = await db.insert(schema.omo_message_queue)
      .values({
        id: 'queue-row-1',
        discord_thread_id: 'discord-thread-Q',
        discord_message_id: 'discord-msg-1',
        omo_thread_id: 'omo-thread-Q',
        client_user_message_id: 'cumi-1',
        content_json: JSON.stringify({ text: 'hello' }),
        status: 'queued',
        turn_id: null,
        attempts: 0,
        created_at: now,
        updated_at: now,
      })
      .returning()
    expect(inserted).toBeDefined()
    expect(inserted?.id).toBe('queue-row-1')
    expect(inserted?.status).toBe('queued')
    expect(inserted?.attempts).toBe(0)
    expect(inserted?.content_json).toBe(JSON.stringify({ text: 'hello' }))

    const found = await db.query.omo_message_queue.findFirst({
      where: { id: 'queue-row-1' },
    })
    expect(found?.discord_thread_id).toBe('discord-thread-Q')
    expect(found?.client_user_message_id).toBe('cumi-1')

    // Duplicate client_user_message_id must violate the UNIQUE constraint.
    await expect(
      db.insert(schema.omo_message_queue).values({
        id: 'queue-row-2',
        discord_thread_id: 'discord-thread-Q',
        discord_message_id: 'discord-msg-2',
        omo_thread_id: 'omo-thread-Q',
        client_user_message_id: 'cumi-1',
        content_json: JSON.stringify({ text: 'dup' }),
        status: 'queued',
        turn_id: null,
        attempts: 0,
        created_at: now,
        updated_at: now,
      }),
    ).rejects.toThrow()

    // Cleanup
    await db.delete(schema.omo_message_queue).where(
      orm.eq(schema.omo_message_queue.id, 'queue-row-1'),
    )
  })

  test('security_audit round-trips a minimal row', async () => {
    const db = await getDb()
    const now = new Date().toISOString()

    const [inserted] = await db.insert(schema.security_audit)
      .values({
        id: 'audit-row-1',
        at: now,
        actor_user_id: 'user-42',
        guild_id: 'guild-7',
        channel_id: 'channel-9',
        action: 'thread.start',
        cwd: '/home/user/proj',
        detail_json: JSON.stringify({ foo: 'bar' }),
      })
      .returning()
    expect(inserted).toBeDefined()
    expect(inserted?.id).toBe('audit-row-1')
    expect(inserted?.actor_user_id).toBe('user-42')
    expect(inserted?.action).toBe('thread.start')
    expect(inserted?.detail_json).toBe(JSON.stringify({ foo: 'bar' }))

    const found = await db.query.security_audit.findFirst({
      where: { id: 'audit-row-1' },
    })
    expect(found?.guild_id).toBe('guild-7')
    expect(found?.cwd).toBe('/home/user/proj')

    // Cleanup
    await db.delete(schema.security_audit).where(
      orm.eq(schema.security_audit.id, 'audit-row-1'),
    )
  })

  test('omo_message_queue has the (status, created_at) index', async () => {
    const db = await getDb()
    const rows = await db.all<{ name: string }>(orm.sql`
      SELECT name FROM sqlite_master
      WHERE type='index' AND name='omo_message_queue_status_created_at_idx'
    `)
    expect(rows.length).toBe(1)
  })
})
