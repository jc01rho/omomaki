// Undo/Redo commands - /undo, /redo

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import { getOpencodeClient, initializeOpencodeForDirectory } from '../opencode.js'
import { getOmoRpcOpencodeClient } from '../omo-bridge/rpc-opencode-client.js'
import { shouldUseOmoRpc } from '../omo-bridge/rpc-session.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.UNDO_REDO)

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return JSON.stringify(error)
}

async function waitForSessionIdle({
  client,
  sessionId,
  directory,
  timeoutMs = 2_000,
}: {
  client: OpencodeClient
  sessionId: string
  directory: string
  timeoutMs?: number
}): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const statusResponse = await client.session.status({
      directory,
      sessionID: sessionId,
    } as Parameters<OpencodeClient['session']['status']>[0])
    const sessionStatus = statusResponse.data?.[sessionId]
    if (!sessionStatus || sessionStatus.type === 'idle') {
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }
}

export async function handleUndoCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory, workingDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply()

  const useOmoRpc = shouldUseOmoRpc()

  let client: OpencodeClient | undefined
  if (useOmoRpc) {
    // omo RPC 경로에서는 OpenCode 서버를 절대 기동하지 않는다.
    // rpc-opencode-client 셈이 session.revert/unrevert/messages/status를
    // navigate_tree / get_messages / get_state로 매핑해 처리한다.
    client = getOmoRpcOpencodeClient(workingDirectory)
  } else {
    const serverResult = await initializeOpencodeForDirectory(projectDirectory)
    if (serverResult instanceof Error) {
      await command.editReply(`Failed to undo: ${serverResult.message}`)
      return
    }
    const resolvedClient = getOpencodeClient(workingDirectory)
    if (!resolvedClient) {
      await command.editReply('Failed to get OpenCode client')
      return
    }
    client = resolvedClient
  }

  try {
    // Fetch session to check existing revert state
    const sessionResponse = await client.session.get({
      sessionID: sessionId,
      directory: workingDirectory,
    })
    if (sessionResponse.error) {
      if (useOmoRpc) {
        await command.editReply(
          `실행 취소에 실패했습니다: ${getErrorMessage(sessionResponse.error)}`,
        )
        return
      }
      await command.editReply(`Failed to undo: ${JSON.stringify(sessionResponse.error)}`)
      return
    }

    // Abort if session is busy before reverting, matching TUI behavior
    // (use-session-commands.tsx always aborts non-idle sessions before revert).
    // session.status() returns a sparse map — only non-idle sessions have entries,
    // so a missing key means idle.
    const statusResponse = await client.session.status({
      directory: workingDirectory,
      sessionID: sessionId,
    } as Parameters<OpencodeClient['session']['status']>[0])
    const sessionStatus = statusResponse.data?.[sessionId]
    if (sessionStatus && sessionStatus.type !== 'idle') {
      await client.session.abort({
        sessionID: sessionId,
        directory: workingDirectory,
      }).catch((error) => {
        logger.warn(`[UNDO] abort failed for ${sessionId}`, error)
      })
      await waitForSessionIdle({
        client,
        sessionId,
        directory: workingDirectory,
      })
    }

    const messagesResponse = await client.session.messages({
      sessionID: sessionId,
      directory: workingDirectory,
    })
    if (messagesResponse.error) {
      if (useOmoRpc) {
        await command.editReply(
          `실행 취소에 실패했습니다: ${getErrorMessage(messagesResponse.error)}`,
        )
        return
      }
      await command.editReply(`Failed to undo: ${JSON.stringify(messagesResponse.error)}`)
      return
    }

    if (!messagesResponse.data || messagesResponse.data.length === 0) {
      await command.editReply(useOmoRpc ? '실행 취소할 메시지가 없습니다' : 'No messages to undo')
      return
    }

    // Follow the same approach as the OpenCode TUI (use-session-commands.tsx):
    // find the last user message that is before the current revert point
    // (or the last user message if no revert is active). This matches the
    // TUI's `findLast(userMessages(), (x) => !revert || x.id < revert)`.
    const currentRevert = sessionResponse.data?.revert?.messageID
    const userMessages = messagesResponse.data.filter((m) => {
      return m.info.role === 'user'
    })
    const targetUserMessage = [...userMessages].reverse().find((m) => {
      return !currentRevert || m.info.id < currentRevert
    })

    if (!targetUserMessage) {
      await command.editReply(useOmoRpc ? '실행 취소할 메시지가 없습니다' : 'No messages to undo')
      return
    }

    const targetAssistantMessage = [...messagesResponse.data].reverse().find((m) => {
      return m.info.role === 'assistant' && m.info.parentID === targetUserMessage.info.id
    })
    const revertMessageId = targetAssistantMessage?.info.id || targetUserMessage.info.id

    // session.revert() reverts filesystem patches (file edits, writes) and
    // marks the session with revert.messageID. Messages are NOT deleted — they
    // get cleaned up automatically on the next promptAsync() call via
    // SessionRevert.cleanup(). The model only sees messages before the revert
    // point when processing the next prompt.
    //
    // Under omo RPC, session.revert() is the shim in rpc-opencode-client.ts,
    // which maps this call onto the classic RPC `navigate_tree` request
    // instead of touching an OpenCode server.
    logger.log(`[UNDO] session.revert start messageId=${revertMessageId}`)
    let response = await client.session.revert({
      sessionID: sessionId,
      directory: workingDirectory,
      messageID: revertMessageId,
    })
    logger.log(`[UNDO] session.revert done error=${Boolean(response.error)}`)

    if (response.error) {
      logger.log('[UNDO] retry wait idle before revert retry')
      await waitForSessionIdle({
        client,
        sessionId,
        directory: workingDirectory,
      })
      logger.log('[UNDO] retry revert start')
      response = await client.session.revert({
        sessionID: sessionId,
        directory: workingDirectory,
        messageID: revertMessageId,
      })
      logger.log(`[UNDO] retry revert done error=${Boolean(response.error)}`)
      if (response.error) {
        if (useOmoRpc) {
          await command.editReply(
            `실행 취소에 실패했습니다: ${getErrorMessage(response.error)}`,
          )
          return
        }
        await command.editReply(
          `Failed to undo: ${JSON.stringify(response.error)}`,
        )
        return
      }
    }

    const diffInfo = response.data?.revert?.diff
      ? `\n\`\`\`diff\n${response.data.revert.diff.slice(0, 1500)}\n\`\`\``
      : ''

    await command.editReply(
      useOmoRpc
        ? `실행 취소 완료 - 마지막 어시스턴트 메시지를 되돌렸습니다${diffInfo}`
        : `Undone - reverted last assistant message${diffInfo}`,
    )
    logger.log(
      `Session ${sessionId} reverted at message ${revertMessageId}`,
    )
  } catch (error) {
    logger.error('[UNDO] Error:', error)
    if (useOmoRpc) {
      await command.editReply(
        `실행 취소에 실패했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`,
      )
      return
    }
    await command.editReply(
      `Failed to undo: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

export async function handleRedoCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory, workingDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply()

  const useOmoRpc = shouldUseOmoRpc()

  let client: OpencodeClient | undefined
  if (useOmoRpc) {
    // omo RPC 경로에서는 OpenCode 서버를 절대 기동하지 않는다.
    // rpc-opencode-client 셈이 session.revert/unrevert/messages/status를
    // navigate_tree / get_messages / get_state로 매핑해 처리한다.
    client = getOmoRpcOpencodeClient(workingDirectory)
  } else {
    const serverResult = await initializeOpencodeForDirectory(projectDirectory)
    if (serverResult instanceof Error) {
      await command.editReply(`Failed to redo: ${serverResult.message}`)
      return
    }
    const resolvedClient = getOpencodeClient(workingDirectory)
    if (!resolvedClient) {
      await command.editReply('Failed to get OpenCode client')
      return
    }
    client = resolvedClient
  }

  try {
    // Fetch session to check existing revert state
    const sessionResponse = await client.session.get({
      sessionID: sessionId,
      directory: workingDirectory,
    })
    if (sessionResponse.error) {
      if (useOmoRpc) {
        await command.editReply(
          `다시 실행에 실패했습니다: ${getErrorMessage(sessionResponse.error)}`,
        )
        return
      }
      await command.editReply(`Failed to redo: ${JSON.stringify(sessionResponse.error)}`)
      return
    }

    const revertMessageID = sessionResponse.data?.revert?.messageID
    if (!revertMessageID) {
      await command.editReply(
        useOmoRpc ? '다시 실행할 이전 실행 취소 기록이 없습니다' : 'Nothing to redo - no previous undo found',
      )
      return
    }

    // Abort if session is busy before reverting/unreverting — both enforce
    // assertNotBusy in OpenCode and would fail with "Session is busy".
    // Under omo RPC this routes through the same shim (session.abort ->
    // client.request('abort'), session.status -> client.request('get_state')),
    // so busy-abort semantics still hold without booting OpenCode.
    const redoStatusResponse = await client.session.status({
      directory: workingDirectory,
      sessionID: sessionId,
    } as Parameters<OpencodeClient['session']['status']>[0])
    const redoSessionStatus = redoStatusResponse.data?.[sessionId]
    if (redoSessionStatus && redoSessionStatus.type !== 'idle') {
      await client.session.abort({
        sessionID: sessionId,
        directory: workingDirectory,
      }).catch((error) => {
        logger.warn(`[REDO] abort failed for ${sessionId}`, error)
      })
      await waitForSessionIdle({
        client,
        sessionId,
        directory: workingDirectory,
      })
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500)
    })

    // Follow the same approach as the OpenCode TUI (use-session-commands.tsx):
    // find the next user message after the current revert point. If one exists,
    // move the revert cursor forward to it (one step redo). If none exists,
    // fully unrevert — we're at the end of the message history.
    const messagesResponse = await client.session.messages({
      sessionID: sessionId,
      directory: workingDirectory,
    })
    if (messagesResponse.error) {
      if (useOmoRpc) {
        await command.editReply(
          `다시 실행에 실패했습니다: ${getErrorMessage(messagesResponse.error)}`,
        )
        return
      }
      await command.editReply(`Failed to redo: ${JSON.stringify(messagesResponse.error)}`)
      return
    }
    const userMessages = (messagesResponse.data ?? []).filter((m) => {
      return m.info.role === 'user'
    })
    const nextMessage = userMessages.find((m) => {
      return m.info.id > revertMessageID
    })

    if (!nextMessage) {
      // No more messages after revert point — fully unrevert.
      // Under omo RPC, session.unrevert() maps onto get_messages + navigate_tree
      // to the latest message id (forward to the tip of history).
      const response = await client.session.unrevert({
        sessionID: sessionId,
        directory: workingDirectory,
      })
      if (response.error) {
        if (useOmoRpc) {
          await command.editReply(
            `다시 실행에 실패했습니다: ${getErrorMessage(response.error)}`,
          )
          return
        }
        await command.editReply(
          `Failed to redo: ${JSON.stringify(response.error)}`,
        )
        return
      }
      await command.editReply(
        useOmoRpc ? '복원 완료 - 세션이 이전 상태로 완전히 돌아갔습니다' : 'Restored - session fully back to previous state',
      )
      logger.log(`Session ${sessionId} unrevert completed`)
      return
    }

    // Move revert cursor forward one step to the next user message
    const response = await client.session.revert({
      sessionID: sessionId,
      directory: workingDirectory,
      messageID: nextMessage.info.id,
    })

    if (response.error) {
      if (useOmoRpc) {
        await command.editReply(
          `다시 실행에 실패했습니다: ${getErrorMessage(response.error)}`,
        )
        return
      }
      await command.editReply(
        `Failed to redo: ${JSON.stringify(response.error)}`,
      )
      return
    }

    await command.editReply(useOmoRpc ? '한 단계 앞으로 복원했습니다' : 'Restored one step forward')
    logger.log(`Session ${sessionId} redo: moved revert to ${nextMessage.info.id}`)
  } catch (error) {
    logger.error('[REDO] Error:', error)
    if (useOmoRpc) {
      await command.editReply(
        `다시 실행에 실패했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`,
      )
      return
    }
    await command.editReply(
      `Failed to redo: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
