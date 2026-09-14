import { describe, expect, it, vi } from 'vitest'
import type { SdkJsonRpc } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { ApprovalBridge } from '../src/bridge.ts'
import * as plugin from '../src/index.ts'

function fakeRpc(): SdkJsonRpc & {
  notifications: { method: string; params?: object }[]
  methods: Map<string, (params: Record<string, unknown> | undefined) => unknown>
  capabilities: Set<string>
  shutdownHooks: Array<() => void>
} {
  const notifications: { method: string; params?: object }[] = []
  const methods = new Map<string, (params: Record<string, unknown> | undefined) => unknown>()
  const capabilities = new Set<string>()
  const shutdownHooks: Array<() => void> = []
  return {
    notifications,
    methods,
    capabilities,
    shutdownHooks,
    notify(method, params) {
      notifications.push(params === undefined ? { method } : { method, params })
    },
    registerMethod(method, handler) {
      methods.set(method, handler)
      return () => { methods.delete(method) }
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

describe('ApprovalBridge', () => {
  it('maps allow to allowed-once and rejects unknown or settled ids', async () => {
    const rpc = fakeRpc()
    const bridge = new ApprovalBridge(rpc)
    const outcome = bridge.handle({
      agent: { session: { id: 'sess-approve' } },
      toolName: 'bash',
      reason: 'workspace write',
      callId: 'call-1',
    })

    expect(rpc.notifications).toHaveLength(1)
    expect(rpc.notifications[0]).toMatchObject({
      method: 'approval.require',
      params: {
        sessionId: 'sess-approve',
        toolName: 'bash',
        summary: 'workspace write',
        callId: 'call-1',
      },
    })
    const approvalId = (rpc.notifications[0]?.params as { id: string }).id
    expect(typeof approvalId).toBe('string')

    expect(bridge.respond({ approvalId, decision: 'allow', remember: true })).toEqual({})
    await expect(outcome).resolves.toBe('allowed-once')

    expect(() => bridge.respond({ approvalId, decision: 'deny' }))
      .toThrow(/unknown or already settled/)
  })

  it('maps deny to rejected and abort to cancelled', async () => {
    const rpc = fakeRpc()
    const bridge = new ApprovalBridge(rpc)

    const denyPromise = bridge.handle({ agent: { session: { id: 's-deny' } }, toolName: 'write' })
    const denyId = (rpc.notifications[0]?.params as { id: string }).id
    bridge.respond({ approvalId: denyId, decision: 'deny' })
    await expect(denyPromise).resolves.toBe('rejected')

    const ac = new AbortController()
    const abortPromise = bridge.handle({
      agent: { session: { id: 's-abort' } },
      toolName: 'bash',
      signal: ac.signal,
    })
    expect(rpc.notifications).toHaveLength(2)
    ac.abort()
    await expect(abortPromise).resolves.toBe('cancelled')
  })

  it('returns cancelled for pre-aborted signals and after cancelAll', async () => {
    const rpc = fakeRpc()
    const bridge = new ApprovalBridge(rpc)
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(bridge.handle({
      agent: { session: { id: 'pre' } },
      toolName: 'bash',
      signal: preAborted.signal,
    })).resolves.toBe('cancelled')
    expect(rpc.notifications).toHaveLength(0)

    const pending = bridge.handle({ agent: { session: { id: 'live' } }, toolName: 'bash' })
    expect(rpc.notifications).toHaveLength(1)
    bridge.cancelAll('cancelled')
    await expect(pending).resolves.toBe('cancelled')
    await expect(bridge.handle({ agent: { session: { id: 'after' } }, toolName: 'bash' }))
      .resolves.toBe('cancelled')
  })

  it('validates approval/respond params', () => {
    const bridge = new ApprovalBridge(fakeRpc())
    expect(() => bridge.respond(undefined)).toThrow(/requires approvalId/)
    expect(() => bridge.respond({ approvalId: 'x', decision: 'maybe' })).toThrow(/requires decision/)
  })
})

describe('sdk-approval-bridge plugin', () => {
  it('registers capability, method, request listener; cancels on shutdown', async () => {
    const rpc = fakeRpc()
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const disposeEffect = vi.fn()
    const ctx = {
      sdkJsonRpc: rpc,
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        listeners.set(event, handler)
        return () => { listeners.delete(event) }
      }),
      effect: vi.fn((factory: () => () => void) => {
        const cleanup = factory()
        disposeEffect.mockImplementation(cleanup)
        return () => undefined
      }),
    }

    expect(plugin.name).toBe('sdk-approval-bridge')
    expect(plugin.inject).toEqual(['sdkJsonRpc'])
    plugin.apply(ctx as never)

    expect(rpc.capabilities.has('approval/respond')).toBe(true)
    expect(rpc.methods.has('approval/respond')).toBe(true)
    expect(listeners.has('approval/request')).toBe(true)
    expect(rpc.shutdownHooks).toHaveLength(1)

    const request = listeners.get('approval/request') as (req: {
      agent: { session: { id: string } }
      toolName: string
    }) => Promise<string>
    const allowOutcome = request({ agent: { session: { id: 'plug' } }, toolName: 'bash' })
    const allowId = (rpc.notifications[0]?.params as { id: string }).id
    expect(rpc.methods.get('approval/respond')!({ approvalId: allowId, decision: 'allow' })).toEqual({})
    await expect(allowOutcome).resolves.toBe('allowed-once')

    const pending = request({ agent: { session: { id: 'shut' } }, toolName: 'write' })
    rpc.shutdownHooks[0]!()
    await expect(pending).resolves.toBe('cancelled')

    disposeEffect()
    expect(rpc.capabilities.has('approval/respond')).toBe(false)
    expect(rpc.methods.has('approval/respond')).toBe(false)
    expect(listeners.has('approval/request')).toBe(false)
  })
})
