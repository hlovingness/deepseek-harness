import { describe, expect, it, vi } from 'vitest'
import type { SdkJsonRpc } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { AssistantStreamBridge } from '../src/bridge.ts'
import * as plugin from '../src/index.ts'

function fakeRpc(): SdkJsonRpc & {
  notifications: { method: string; params?: object }[]
  capabilities: Set<string>
  shutdownHooks: Array<() => void>
} {
  const notifications: { method: string; params?: object }[] = []
  const capabilities = new Set<string>()
  const shutdownHooks: Array<() => void> = []
  return {
    notifications,
    capabilities,
    shutdownHooks,
    notify(method, params) {
      notifications.push(params === undefined ? { method } : { method, params })
    },
    registerMethod() {
      return () => undefined
    },
    addCapability(capability) {
      capabilities.add(capability)
      return () => { capabilities.delete(capability) }
    },
    onShutdown(hook) {
      shutdownHooks.push(hook)
      return () => {
        const i = shutdownHooks.indexOf(hook)
        if (i >= 0) shutdownHooks.splice(i, 1)
      }
    },
  }
}

function agentStub(sessionId: string): { session: { id: string } } {
  return { session: { id: sessionId } }
}

describe('AssistantStreamBridge', () => {
  it('publishes assistant/live-chunk for dense chunk frames after start', () => {
    const rpc = fakeRpc()
    const bridge = new AssistantStreamBridge(rpc)
    const agent = agentStub('sess-1') as never

    bridge.observeDurable(
      { id: 'sess-1' } as never,
      { type: 'turn/start', seq: 10, time: 1, data: {} } as never,
    )

    bridge.accept(agent, {
      type: 'start',
      attemptId: 'att-1' as never,
      revision: 1,
      turn: 2,
      step: 0,
    })
    expect(rpc.notifications).toHaveLength(0)

    const textChunk: AssistantStreamFrame = {
      type: 'chunk',
      attemptId: 'att-1' as never,
      revision: 2,
      index: 0,
      time: 100,
      chunk: { type: 'text-delta', index: 0, text: 'Hel' },
    }
    bridge.accept(agent, textChunk)

    expect(rpc.notifications).toHaveLength(1)
    expect(rpc.notifications[0]).toMatchObject({
      method: 'session.event',
      params: {
        sessionId: 'sess-1',
        event: {
          type: 'assistant/live-chunk',
          time: 100,
          data: {
            attemptId: 'att-1',
            turn: 2,
            step: 0,
            chunk: { type: 'text-delta', index: 0, text: 'Hel' },
          },
        },
      },
    })
    const seq = (rpc.notifications[0]?.params as { event: { seq: number } }).event.seq
    expect(seq).toBeCloseTo(10 + 1 - 1 / 2, 8)

    bridge.accept(agent, {
      type: 'chunk',
      attemptId: 'att-1' as never,
      revision: 3,
      index: 1,
      time: 101,
      chunk: { type: 'reasoning-delta', index: 1, text: 'think' },
    })
    expect(rpc.notifications).toHaveLength(2)
    expect(rpc.notifications[1]).toMatchObject({
      params: {
        event: {
          type: 'assistant/live-chunk',
          data: { chunk: { type: 'reasoning-delta', text: 'think' } },
        },
      },
    })
  })

  it('ignores orphaned chunks and index gaps until a matching start', () => {
    const rpc = fakeRpc()
    const bridge = new AssistantStreamBridge(rpc)
    const agent = agentStub('sess-2') as never

    bridge.accept(agent, {
      type: 'chunk',
      attemptId: 'orphan' as never,
      revision: 1,
      index: 0,
      time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'x' },
    })
    expect(rpc.notifications).toHaveLength(0)

    bridge.accept(agent, {
      type: 'start',
      attemptId: 'att-2' as never,
      revision: 1,
      turn: 1,
      step: 0,
    })
    bridge.accept(agent, {
      type: 'chunk',
      attemptId: 'att-2' as never,
      revision: 2,
      index: 1,
      time: 2,
      chunk: { type: 'text-delta', index: 0, text: 'skip' },
    })
    expect(rpc.notifications).toHaveLength(0)
  })

  it('clears attempt state on end and reset', () => {
    const rpc = fakeRpc()
    const bridge = new AssistantStreamBridge(rpc)
    const agent = agentStub('sess-3') as never

    bridge.accept(agent, {
      type: 'start',
      attemptId: 'att-3' as never,
      revision: 1,
      turn: 1,
      step: 0,
    })
    bridge.accept(agent, {
      type: 'end',
      attemptId: 'att-3' as never,
      revision: 2,
      index: 0,
      outcome: { kind: 'abandoned' },
    })
    bridge.accept(agent, {
      type: 'chunk',
      attemptId: 'att-3' as never,
      revision: 3,
      index: 0,
      time: 3,
      chunk: { type: 'text-delta', index: 0, text: 'after-end' },
    })
    expect(rpc.notifications).toHaveLength(0)

    bridge.accept(agent, {
      type: 'start',
      attemptId: 'att-4' as never,
      revision: 1,
      turn: 1,
      step: 0,
    })
    bridge.reset()
    bridge.accept(agent, {
      type: 'chunk',
      attemptId: 'att-4' as never,
      revision: 2,
      index: 0,
      time: 4,
      chunk: { type: 'text-delta', index: 0, text: 'after-reset' },
    })
    expect(rpc.notifications).toHaveLength(0)
  })
})

describe('sdk-assistant-stream-bridge plugin', () => {
  it('exports Cordis plugin metadata and wires capability + listeners', () => {
    expect(plugin.name).toBe('sdk-assistant-stream-bridge')
    expect(plugin.inject).toEqual(['sdkJsonRpc'])

    const rpc = fakeRpc()
    const on = vi.fn()
    const ctx = {
      sdkJsonRpc: rpc,
      on,
    }
    plugin.apply(ctx as never)

    expect(rpc.capabilities.has('assistant/live-chunk')).toBe(true)
    expect(rpc.shutdownHooks).toHaveLength(1)
    expect(on).toHaveBeenCalledWith('session/event', expect.any(Function))
    expect(on).toHaveBeenCalledWith('agent/assistant-stream', expect.any(Function))
  })
})
