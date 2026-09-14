/**
 * Cordis plugin: bridge host `approval/request` to the out-of-process SDK
 * client over `approval.require` / `approval/respond`. Mounted on the `sdk`
 * profile after `@deepseek-ai/dsh-sdk-jsonrpc-server`.
 *
 * Keep named exports with no default so Loader `unwrapExports` preserves
 * `name`, `inject`, and `apply`.
 *
 * @module @deepseek-ai/dsh-sdk-approval-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
// Pull Host `approval/request` Events augmentation (types only).
import type {} from '@deepseek-ai/dsh-user-approval'
import { ApprovalBridge } from './bridge.ts'

export { ApprovalBridge } from './bridge.ts'
export type { ApprovalOutcome, ApprovalRequestLike } from './bridge.ts'

export const name = 'sdk-approval-bridge'
/** Requires the JSON-RPC extension surface provided by the SDK server plugin. */
export const inject = ['sdkJsonRpc']

/** Register the approval bridge on the shared SDK JSON-RPC channel. */
export function apply(ctx: Context): void {
  const bridge = new ApprovalBridge(ctx.sdkJsonRpc)

  ctx.effect(() => {
    const offCapability = ctx.sdkJsonRpc.addCapability('approval/respond')
    const offMethod = ctx.sdkJsonRpc.registerMethod('approval/respond', params => bridge.respond(params))
    const offShutdown = ctx.sdkJsonRpc.onShutdown(() => bridge.cancelAll('cancelled'))
    const offRequest = ctx.on('approval/request', req => bridge.handle(req))
    return () => {
      offRequest()
      offShutdown()
      offMethod()
      offCapability()
      bridge.cancelAll('cancelled')
    }
  }, 'sdk-approval-bridge')
}
