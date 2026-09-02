type OmomakiApproveToolEvent = {
  readonly tool_name?: string
  readonly toolName?: string
}

type OmomakiApproveUi = {
  confirm(
    title: string,
    message: string,
    opts?: { readonly timeout?: number },
  ): Promise<boolean>
}

type OmomakiApproveContext = {
  readonly ui: OmomakiApproveUi
}

type OmomakiApproveHost = {
  on(
    event: 'tool_call',
    handler: (
      event: OmomakiApproveToolEvent,
      ctx: OmomakiApproveContext,
    ) => Promise<{ readonly block: true } | undefined>,
  ): void
}

const GATED_TOOLS = new Set(['bash', 'edit', 'write'])

// Senpi loads each exported function as a plugin initializer; default export
// is required by the extension loader (named activate is ignored).
export default function omomakiApprove(pi: OmomakiApproveHost): void {
  pi.on('tool_call', async (event, ctx) => {
    const toolName = event.tool_name ?? event.toolName
    if (toolName === undefined || !GATED_TOOLS.has(toolName)) {
      return undefined
    }
    let approved = false
    try {
      approved = await ctx.ui.confirm(
        `Approve ${toolName} tool call`,
        `Do you want to proceed with this ${toolName} tool call?`,
        { timeout: 60_000 },
      )
    } catch {
      return { block: true }
    }
    if (!approved) {
      return { block: true }
    }
    return undefined
  })
}
