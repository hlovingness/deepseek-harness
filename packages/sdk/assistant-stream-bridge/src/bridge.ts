/**
 * Fold process-local `agent/assistant-stream` frames into transient
 * `assistant/live-chunk` session.event notifications (Web ClientAssistantStream
 * parity for out-of-process SDK clients).
 *
 * @module @deepseek-ai/dsh-sdk-assistant-stream-bridge/bridge
 */

import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEventNotification } from '@deepseek-ai/dsh-sdk-protocol'
import type { SdkJsonRpc } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

interface ActiveAttempt {
  readonly turn: number
  readonly step: number
  /** Number of chunk frames already published for this attempt. */
  transientInGap: number
}

/**
 * Bridges Host assistant-stream publications to desktop/native
 * `session.event` notifications carrying `assistant/live-chunk`.
 * Does not append to the durable session log.
 */
export class AssistantStreamBridge {
  private readonly lastDurableSeq = new Map<string, number>()
  private readonly attempts = new Map<string, ActiveAttempt>()

  constructor(private readonly rpc: SdkJsonRpc) {}

  /** Track durable log seq so live-chunk seqs can sit in the fractional gap. */
  observeDurable(session: Session, event: SessionEvent): void {
    this.lastDurableSeq.set(String(session.id), event.seq)
  }

  /**
   * Mirror one assistant-stream frame as a transient live-chunk when appropriate.
   * @param agent - agent that produced the frame.
   * @param frame - start / chunk / end publication from agent-loop.
   */
  accept(agent: Agent, frame: AssistantStreamFrame): void {
    const sessionId = String(agent.session.id)
    const key = attemptKey(sessionId, String(frame.attemptId))
    switch (frame.type) {
      case 'start':
        this.attempts.set(key, {
          turn: frame.turn,
          step: frame.step,
          transientInGap: 0,
        })
        return
      case 'end':
        this.attempts.delete(key)
        return
      case 'chunk': {
        const attempt = this.attempts.get(key)
        // Match Web ClientAssistantStream: ignore orphaned suffix until a known start.
        if (attempt === undefined || frame.index !== attempt.transientInGap) return
        attempt.transientInGap += 1
        const durableCursor = this.lastDurableSeq.get(sessionId) ?? -1
        const seq = durableCursor + 1 - 1 / (attempt.transientInGap + 1)
        const payload: SessionEventNotification = {
          sessionId,
          event: {
            type: 'assistant/live-chunk',
            seq,
            time: frame.time,
            data: {
              attemptId: frame.attemptId,
              turn: attempt.turn,
              step: attempt.step,
              chunk: frame.chunk,
            },
          } as unknown as SessionEvent,
        }
        this.rpc.notify('session.event', payload)
        return
      }
    }
  }

  /** Drop attempt bookkeeping (shutdown / tests). */
  reset(): void {
    this.attempts.clear()
    this.lastDurableSeq.clear()
  }
}

function attemptKey(sessionId: string, attemptId: string): string {
  return `${sessionId}:${attemptId}`
}
