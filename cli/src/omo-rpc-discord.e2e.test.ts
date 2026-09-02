import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { expect, test } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setDataDir } from './config.js'
import { startDiscordBot } from './discord-bot.js'
import {
  closeDatabase,
  initDatabase,
  setBotToken,
  setChannelDirectory,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { setRpcSessionSpawnForTests } from './omo-bridge/rpc-session.js'
import { store } from './store.js'
import {
  chooseLockPort,
  initTestGitRepo,
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'

const TEST_USER_ID = '300000000000000777'
const TEXT_CHANNEL_ID = '300000000000000778'
const FIXTURE_PATH = url.fileURLToPath(
  new URL('./omo-bridge/__fixtures__/fake-rpc-server.mjs', import.meta.url),
)

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'omo-rpc-discord-e2e')
  fs.mkdirSync(root, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  initTestGitRepo(projectDirectory)
  return { root, dataDir, projectDirectory }
}

function createDiscordJsClient({ restUrl }: { restUrl: string }) {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.ThreadMember,
    ],
    rest: {
      api: restUrl,
      version: '10',
    },
  })
}

test('discord thread message prompts omo rpc and posts RPC-OK-ONLY', async () => {
  const directories = createRunDirectories()
  const lockPort = chooseLockPort({ key: 'omo-rpc-discord-e2e' })
  process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
  process.env['KIMAKI_USE_OMO_RPC'] = '1'
  setDataDir(directories.dataDir)
  setRpcSessionSpawnForTests({
    command: process.execPath,
    args: [FIXTURE_PATH],
  })
  const previousDefaultVerbosity = store.getState().defaultVerbosity
  store.setState({ defaultVerbosity: 'text_only' })

  const discord = new DigitalDiscord({
    guild: {
      name: 'Omo RPC E2E Guild',
      ownerId: TEST_USER_ID,
    },
    channels: [
      {
        id: TEXT_CHANNEL_ID,
        name: 'omo-rpc-e2e',
        type: ChannelType.GuildText,
      },
    ],
    users: [
      {
        id: TEST_USER_ID,
        username: 'rpc-tester',
      },
    ],
    dbUrl: `file:${path.join(directories.dataDir, 'digital-discord.db')}`,
  })

  let botClient: Client | undefined
  try {
    await discord.start()
    const dbPath = path.join(directories.dataDir, 'discord-sessions.db')
    const hranaResult = await startHranaServer({ dbPath })
    if (hranaResult instanceof Error) {
      throw hranaResult
    }
    process.env['KIMAKI_DB_URL'] = hranaResult
    await initDatabase()
    await setBotToken(discord.botUserId, discord.botToken)
    await setChannelDirectory({
      channelId: TEXT_CHANNEL_ID,
      directory: directories.projectDirectory,
      channelType: 'text',
    })

    botClient = createDiscordJsClient({ restUrl: discord.restUrl })
    await startDiscordBot({
      token: discord.botToken,
      appId: discord.botUserId,
      discordClient: botClient,
    })

    const prompt = 'Reply with exactly: RPC-OK-ONLY'
    await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: prompt,
    })
    const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 8_000,
      predicate: (candidate) => candidate.name === prompt,
    })
    await waitForBotMessageContaining({
      discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'RPC-OK-ONLY',
      timeout: 8_000,
    })
    await waitForFooterMessage({
      discord,
      threadId: thread.id,
      timeout: 8_000,
      afterMessageIncludes: 'RPC-OK-ONLY',
    })
    expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
      "--- from: user (rpc-tester)
      Reply with exactly: RPC-OK-ONLY
      --- from: assistant (TestBot)
      ⬥ RPC-OK-ONLY
      *project ⋅ main ⋅ Ns ⋅ omo-rpc*"
    `)
  } finally {
    setRpcSessionSpawnForTests(undefined)
    delete process.env['KIMAKI_USE_OMO_RPC']
    delete process.env['KIMAKI_LOCK_PORT']
    delete process.env['KIMAKI_DB_URL']
    store.setState({ defaultVerbosity: previousDefaultVerbosity })
    if (botClient) {
      void botClient.destroy()
    }
    await Promise.all([
      closeDatabase().catch(() => undefined),
      stopHranaServer().catch(() => undefined),
      discord.stop().catch(() => undefined),
    ])
    fs.rmSync(directories.dataDir, { recursive: true, force: true })
  }
}, 20_000)
