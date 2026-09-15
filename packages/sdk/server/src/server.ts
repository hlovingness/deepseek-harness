/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { admitEncodedImages, type EncodedImageAttachment, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SdkEncodedImageBlock,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'
import type { SdkJsonRpc, SdkJsonRpcMethodHandler } from './extension.ts'

export type { SdkJsonRpc, SdkJsonRpcMethodHandler } from './extension.ts'

/** Optional agent-presets roster (present when the deployment mounts it). */
interface AgentPresetsService {
  mount(agentCtx: Context, id?: string): Promise<{ id: string }>
  select(agent: Agent, agentPreset: string): Promise<string>
  compositionInventory(): Promise<readonly {
    id: string
    trust: 'system' | 'user'
    name?: string
    isDefault: boolean
    broken?: string
    rows: readonly {
      entryId: string | null
      moduleName: string
      enabled: boolean | 'conditional'
      condition?: string
      fiberState?: FiberState
    }[]
  }[]>
}

/** Fiber phase labels aligned with host plugin-inventory. */
const FIBER_PHASE: Record<number, string | null> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

interface SessionRecord {
  handle: AgentHandle
}

function encodedImage(block: SessionPromptParams['contentBlocks'][number]): block is SdkEncodedImageBlock {
  return block.type === 'image' && 'data' in block
}

async function durablePromptContent(ctx: Context, blocks: SessionPromptParams['contentBlocks']): Promise<ContentBlock[]> {
  const images = blocks.filter(encodedImage)
  if (images.length === 0) return blocks as ContentBlock[]
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('SDK image prompt requires an attachment store')
  const refs = await admitEncodedImages(attachments, images.map((image): EncodedImageAttachment => ({
    data: image.data,
    mediaType: image.mimeType,
  })))
  let next = 0
  return blocks.map(block => encodedImage(block)
    ? { type: 'image', attachment: refs[next++] as ImageAttachmentRef }
    : block)
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private reasoningEffort: ReturnType<typeof ReasoningEffortId> | undefined
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  /** sessionId → preset id to mount on first create (creator chip / explicit select). */
  private readonly pendingPresets = new Map<string, string>()
  /** Sibling-plugin JSON-RPC methods (see {@link SdkJsonRpc.registerMethod}). */
  private readonly extensionMethods = new Map<string, SdkJsonRpcMethodHandler>()
  /** Extra `initialize.capabilities` entries from sibling plugins. */
  private readonly extensionCapabilities = new Set<string>()
  private readonly shutdownHooks: Array<() => void> = []
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false
  private initialized = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /** Expose the sibling-plugin extension surface (provided as `ctx.sdkJsonRpc`). */
  asExtensionApi(): SdkJsonRpc {
    return {
      notify: (method, params) => this.transport.notify(method, params),
      registerMethod: (method, handler) => this.registerMethod(method, handler),
      addCapability: capability => this.addCapability(capability),
      onShutdown: hook => this.onShutdown(hook),
    }
  }

  /** Register a sibling-plugin JSON-RPC method. Core methods always win. */
  registerMethod(method: string, handler: SdkJsonRpcMethodHandler): () => void {
    this.extensionMethods.set(method, handler)
    return () => {
      if (this.extensionMethods.get(method) === handler) this.extensionMethods.delete(method)
    }
  }

  /** Advertise an extra capability string on subsequent `initialize` results. */
  addCapability(capability: string): () => void {
    this.extensionCapabilities.add(capability)
    return () => { this.extensionCapabilities.delete(capability) }
  }

  /** Register a hook invoked at the start of {@link shutdown}. */
  onShutdown(hook: () => void): () => void {
    this.shutdownHooks.push(hook)
    return () => {
      const i = this.shutdownHooks.indexOf(hook)
      if (i >= 0) this.shutdownHooks.splice(i, 1)
    }
  }

  /**
   * Validate and configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.reasoningEffort !== undefined
      && (typeof params.reasoningEffort !== 'string' || params.reasoningEffort.length === 0)) {
      throw new TypeError('initialize reasoningEffort must be a non-empty string')
    }
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    const cwd = resolve(params.cwd)
    const provider = params.provider
    const model = params.model
    const reasoningEffort = params.reasoningEffort === undefined
      ? undefined
      : ReasoningEffortId(params.reasoningEffort)
    if (!this.hasAdapterFor(provider)) {
      if (provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek)
    }
    // Adapter presence was read from this service above; a successful fallback mount also requires it.
    const llm = this.ctx.get('llm') as LlmRuntime
    await llm.resolveCallConfig({
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens },
    })
    this.cwd = cwd
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.maxTokens = params.maxTokens
    this.initialized = true
    const capabilities = ['pluginInventory/list', 'agent/stop', 'agent/cancel', ...this.extensionCapabilities]
    if (this.ctx.get('agentPresets') !== undefined) {
      capabilities.push('agentPresets/select')
    }
    // Extra `capabilities` string[] is a desktop/native extension on top of the
    // wire-stable InitializeResult; official SDK clients ignore unknown fields.
    return {
      serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' },
      capabilities,
    } as InitializeResult & { capabilities: string[] }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams & { agentPreset?: string }): Promise<SessionPromptResult> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const staged = typeof params.agentPreset === 'string' && params.agentPreset.length > 0
      ? params.agentPreset
      : undefined
    if (staged !== undefined) this.pendingPresets.set(params.sessionId, staged)
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery.
    this.assertLiveAgent(rec, params.sessionId)
    const content = await durablePromptContent(this.ctx, params.contentBlocks)
    // Attachment admission crosses an async boundary where shutdown or an
    // agent-loop reload may detach the retained handle.
    this.assertLiveAgent(rec, params.sessionId)
    const message = createUserMessage({
      content,
      source: { kind: 'user' },
    })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  private assertLiveAgent(rec: SessionRecord, sessionId: string): void {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    for (const hook of [...this.shutdownHooks]) {
      try { hook() } catch { /* extension shutdown hooks must not block teardown */ }
    }
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams & { agentPreset?: string })
      case 'pluginInventory/list':
        return this.listPluginInventory()
      case 'agentPresets/select':
        return this.selectAgentPreset(params)
      case 'agent/stop':
      case 'agent/cancel':
        return this.stopAgent(params)
      case 'shutdown':
        return this.shutdown()
      default: {
        const extension = this.extensionMethods.get(method)
        if (extension !== undefined) return extension(params)
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
      }
    }
  }


  /**
   * Interrupt the live agent for a session (user Stop). Maps to `Agent.cancel`.
   * @param params - `{ sessionId }`
   */
  private stopAgent(params: Record<string, unknown> | undefined): Record<string, never> {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
    if (!sessionId) throw new Error('agent/stop requires sessionId')
    const rec = this.sessions.get(sessionId)
    if (rec === undefined) {
      // No live agent yet (prompt not delivered) — nothing to interrupt.
      return {}
    }
    this.assertLiveAgent(rec, sessionId)
    rec.handle.agent.cancel({ kind: 'user' })
    return {}
  }

  /**
   * Loader inventory for desktop settings (same projection as Host
   * `pluginInventory/list`). Uses the live Loader; when agent-presets is
   * mounted, also returns per-preset composition rows.
   */
  private async listPluginInventory(): Promise<{
    entries: {
      entryId: string
      moduleName: string
      enabled: boolean
      fiberPhase: string | null
    }[]
    agentPresets?: {
      id: string
      trust: 'system' | 'user'
      name?: string
      isDefault: boolean
      broken?: string
      rows: {
        entryId: string | null
        moduleName: string
        enabled: boolean | 'conditional'
        condition?: string
        fiberPhase: string | null
      }[]
    }[]
  }> {
    const loader = this.ctx.get('loader')
    const entries: {
      entryId: string
      moduleName: string
      enabled: boolean
      fiberPhase: string | null
    }[] = []
    if (loader !== undefined) {
      for (const entry of loader.entries()) {
        if (entry.options.group) continue
        entries.push({
          entryId: entry.id,
          moduleName: entry.options.name,
          enabled: !entry.disabled,
          fiberPhase: entry.fiber === undefined
            ? null
            : (FIBER_PHASE[entry.fiber.state as number] ?? null),
        })
      }
    }
    const presets = this.ctx.get('agentPresets') as AgentPresetsService | undefined
    if (presets === undefined) return { entries }
    const agentPresets = (await presets.compositionInventory()).map(composition => ({
      ...composition,
      rows: composition.rows.map(({ fiberState, ...row }) => ({
        ...row,
        fiberPhase: fiberState === undefined ? null : (FIBER_PHASE[fiberState as number] ?? null),
      })),
    }))
    return { entries, agentPresets }
  }

  /**
   * Compose a blank session onto another preset (creator chip / picker).
   * Stages the id when the session agent does not exist yet; otherwise calls
   * the roster's Remote `select`.
   */
  private async selectAgentPreset(
    params: Record<string, unknown> | undefined,
  ): Promise<{ agentPreset: string }> {
    const sessionId = typeof params?.['sessionId'] === 'string' ? params['sessionId'] : ''
    const agentPreset = typeof params?.['agentPreset'] === 'string' ? params['agentPreset'] : ''
    if (!sessionId || !agentPreset) {
      throw new Error('agentPresets/select requires sessionId and agentPreset')
    }
    const presets = this.ctx.get('agentPresets') as AgentPresetsService | undefined
    if (presets === undefined) {
      throw new Error('agentPresets/select requires @deepseek-ai/dsh-agent-presets in the deployment')
    }
    const existing = this.sessions.get(sessionId)
    if (existing === undefined) {
      this.pendingPresets.set(sessionId, agentPreset)
      return { agentPreset }
    }
    const applied = await presets.select(existing.handle.agent, agentPreset)
    return { agentPreset: applied }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    const presets = this.ctx.get('agentPresets') as AgentPresetsService | undefined
    const staged = this.pendingPresets.get(sessionId)
    this.pendingPresets.delete(sessionId)
    // When a roster is mounted, compose each SDK session from the staged
    // preset (creator chip) or the roster default — same contract as Web.
    const handle = await this.ctx.agents.create({
      sessionId: brandString<SessionId>(sessionId),
      meta: {
        cwd: this.cwd,
        ...staged === undefined ? {} : { agentPreset: staged },
      },
      agentOptions: {
        provider: this.provider,
        model: this.model,
        ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
        ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
      },
      ...presets === undefined
        ? {}
        : {
          setup: async (agentCtx: Context) => {
            await presets.mount(agentCtx, staged)
          },
        },
    })
    const rec: SessionRecord = { handle }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
