/**
 * Extension surface for sibling Cordis plugins that need to speak on the SDK
 * JSON-RPC stdio channel (register methods, advertise capabilities, notify).
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/extension
 */

// Ensure `@deepseek-ai/cordis` resolves as a real module before augmentation
// (bare `declare module` would otherwise create an ambient shadow Context).
import type {} from '@deepseek-ai/cordis'

/** Handler for one client→server JSON-RPC method registered by an extension. */
export type SdkJsonRpcMethodHandler = (
  params: Record<string, unknown> | undefined,
) => unknown | Promise<unknown>

/**
 * Injectable `ctx.sdkJsonRpc` service provided by the JSON-RPC server plugin.
 * Sibling plugins (e.g. approval-bridge) must inject this — do not call
 * `transport.onRequest` yourself or you will replace the primary dispatcher.
 */
export interface SdkJsonRpc {
  /** Send a server→client notification on the shared stdio transport. */
  notify(method: string, params?: object): void
  /**
   * Register a client→server method. Returns an unregister function.
   * Core switch methods are tried first; extensions handle the remainder.
   */
  registerMethod(method: string, handler: SdkJsonRpcMethodHandler): () => void
  /** Advertise an `initialize.capabilities` entry. Returns an unregister function. */
  addCapability(capability: string): () => void
  /** Run `hook` when the SDK server begins shutdown (before tearing down sessions). */
  onShutdown(hook: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sdkJsonRpc: SdkJsonRpc
  }
}
