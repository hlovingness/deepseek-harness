/**
 * Pending-approval bookkeeping for the SDK approval bridge.
 *
 * @module @deepseek-ai/dsh-sdk-approval-bridge/bridge
 */

import { randomUUID } from 'node:crypto'
import type {
  ApprovalRequireNotification,
  ApprovalRespondParams,
} from '@deepseek-ai/dsh-sdk-protocol'
import type { SdkJsonRpc } from '@deepseek-ai/dsh-sdk-jsonrpc-server'

/** Closed outcomes from `@deepseek-ai/dsh-user-approval` (structural; no hard dep). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Structural shape of an `approval/request` waterfall payload. */
export interface ApprovalRequestLike {
  readonly agent: { readonly session: { readonly id: unknown } }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void
  onAbort?: () => void
  signal?: AbortSignal
}

/**
 * Bridges host `approval/request` waterfall asks to desktop
 * `approval.require` / `approval/respond` over the shared SDK JSON-RPC channel.
 */
export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>()
  private shuttingDown = false

  constructor(private readonly rpc: SdkJsonRpc) {}

  /**
   * Claim one host ask: notify the client and wait for `approval/respond`.
   * Maps allow→`allowed-once`, deny→`rejected`; abort/shutdown→`cancelled`.
   */
  handle(req: ApprovalRequestLike): Promise<ApprovalOutcome> {
    if (this.shuttingDown) return Promise.resolve('cancelled')
    const signal = req.signal
    if (signal?.aborted) return Promise.resolve('cancelled')

    const id = randomUUID()
    const payload: ApprovalRequireNotification = {
      id,
      sessionId: String(req.agent.session.id),
      toolName: req.toolName,
      ...(req.reason === undefined ? {} : { summary: req.reason }),
      ...(req.callId === undefined ? {} : { callId: req.callId }),
    }

    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false
      const settle = (outcome: ApprovalOutcome) => {
        if (settled) return
        settled = true
        const entry = this.pending.get(id)
        if (entry !== undefined) {
          this.pending.delete(id)
          if (entry.signal !== undefined && entry.onAbort !== undefined) {
            entry.signal.removeEventListener('abort', entry.onAbort)
          }
        }
        resolve(outcome)
      }

      const onAbort = () => settle('cancelled')
      this.pending.set(id, { resolve: settle, signal, onAbort })
      if (signal !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.rpc.notify('approval.require', payload)
    })
  }

  /**
   * Settle one pending approval from the desktop/native client.
   * `remember` is accepted for UI parity but ignored (host grants are one-shot).
   */
  respond(params: Record<string, unknown> | undefined): Record<string, never> {
    const body = params as ApprovalRespondParams | undefined
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : ''
    const decision = body?.decision
    if (!approvalId) throw new Error('approval/respond requires approvalId')
    if (decision !== 'allow' && decision !== 'deny') {
      throw new Error('approval/respond requires decision "allow" or "deny"')
    }
    const entry = this.pending.get(approvalId)
    if (entry === undefined) {
      throw new Error(`unknown or already settled approvalId: ${approvalId}`)
    }
    entry.resolve(decision === 'allow' ? 'allowed-once' : 'rejected')
    return {}
  }

  /** Cancel every outstanding ask (shutdown / plugin dispose). */
  cancelAll(outcome: ApprovalOutcome = 'cancelled'): void {
    this.shuttingDown = true
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.signal !== undefined && entry.onAbort !== undefined) {
        entry.signal.removeEventListener('abort', entry.onAbort)
      }
      entry.resolve(outcome)
    }
  }
}
