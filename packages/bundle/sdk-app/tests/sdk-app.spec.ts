/** The SDK app bundle's declared profile patch. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-sdk-app bundle', () => {
  it('declares startup-gated JSON-RPC serving without overriding base HMR policy', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-sdk-jsonrpc-server')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-sdk-approval-bridge')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-sdk-assistant-stream-bridge')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ id?: string; disabled?: boolean; insert?: Array<{ id?: string; inject?: string[]; name?: string }> }>
    expect(patches.find(patch => patch.id === 'hmr')).toBeUndefined()
    expect(patches.find(patch => patch.id === 'session-title-llm')).toMatchObject({ disabled: true })
    const rows = patches.flatMap(patch => patch.insert ?? [])
    expect(rows.find(row => row.id === 'sdk-app-startup')?.name).toBe('@deepseek-ai/dsh-sdk-app')
    expect(rows.find(row => row.id === 'sdk-jsonrpc-server')?.inject).toEqual(['sdkAppStartup', 'loader'])
    const approvalBridge = rows.find(row => row.id === 'sdk-approval-bridge')
    expect(approvalBridge?.name).toBe('@deepseek-ai/dsh-sdk-approval-bridge')
    expect(approvalBridge?.inject).toEqual(['sdkJsonRpc'])
    const streamBridge = rows.find(row => row.id === 'sdk-assistant-stream-bridge')
    expect(streamBridge?.name).toBe('@deepseek-ai/dsh-sdk-assistant-stream-bridge')
    expect(streamBridge?.inject).toEqual(['sdkJsonRpc'])
    const jsonRpcIndex = rows.findIndex(row => row.id === 'sdk-jsonrpc-server')
    const approvalIndex = rows.findIndex(row => row.id === 'sdk-approval-bridge')
    const streamIndex = rows.findIndex(row => row.id === 'sdk-assistant-stream-bridge')
    expect(approvalIndex).toBeGreaterThan(jsonRpcIndex)
    expect(streamIndex).toBeGreaterThan(jsonRpcIndex)
  })
})
