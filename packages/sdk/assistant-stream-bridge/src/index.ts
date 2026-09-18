/**
 * Cordis plugin: mirror Host `agent/assistant-stream` frames to out-of-process
 * SDK clients as transient `assistant/live-chunk` `session.event` notifications.
 * Mounted on the `sdk` profile after `@deepseek-ai/dsh-sdk-jsonrpc-server`.
 *
 * Keep named exports with no default so Loader `unwrapExports` preserves
 * `name`, `inject`, and `apply`.
 *
 * @module @deepseek-ai/dsh-sdk-assistant-stream-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
// Pull Agent Events augmentation for `agent/assistant-stream` (types only).
import type {} from '@deepseek-ai/dsh-agent'
import { AssistantStreamBridge } from './bridge.ts'

export { AssistantStreamBridge } from './bridge.ts'

export const name = 'sdk-assistant-stream-bridge'
/** Requires the JSON-RPC extension surface provided by the SDK server plugin. */
export const inject = ['sdkJsonRpc']

/** Register the assistant-stream → live-chunk bridge on the shared SDK JSON-RPC channel. */
export function apply(ctx: Context): void {
  const bridge = new AssistantStreamBridge(ctx.sdkJsonRpc)
  ctx.sdkJsonRpc.addCapability('assistant/live-chunk')
  ctx.sdkJsonRpc.onShutdown(() => bridge.reset())
  // Durable seq tracking: live-chunk seqs sit in the fractional gap after the
  // last committed log event (same scheme as Web ClientAssistantStream).
  ctx.on('session/event', (session, event) => {
    bridge.observeDurable(session, event)
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    bridge.accept(agent, frame)
  })
}
