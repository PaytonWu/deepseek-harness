import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as piAgent from '../src/index.ts'

const stubPath = new URL('./fixtures/stub-pi.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const testToolSignal = new AbortController().signal
const previousHome = process.env.DSH_HOME

interface ChildSummaryFixture {
  childId: string
  state: 'running' | 'idle' | 'inactive'
  cwd: string
  sessionFile: string
  lastResult?: string
}

type ToolValue =
  | { kind: 'started'; childId: string }
  | { kind: 'sent'; childId: string; state: string }
  | { kind: 'interrupted'; childId: string }
  | { kind: 'status' | 'list'; children: ChildSummaryFixture[] }

async function setup(config: piAgent.Config = {}) {
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'pi-tool-'))
  process.env.DSH_HOME = home
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjectionRegistry)
  provideWorkingDirectoryFixture(ctx)
  ctx.provide('llm', { registerAdapter: () => ({ dispose() {}, replace() { return undefined } }) })
  ctx.provide('agents', { create: async () => ({ agent: { options: {} } }) })
  ctx.provide('workspaceRegistry', { create: async () => ({ title: '', attachSession: async () => {} }) })
  await ctx.plugin(piAgent, {
    command: process.execPath,
    args: [stubPath],
    env: {},
    ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)),
  })
  onTestFinished(async () => {
    process.env.DSH_HOME = previousHome
    await ctx.fiber.dispose().catch(() => undefined)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  })
  const parent = { id: SessionId('pi-caller'), options: {}, session: { header: { cwd: process.cwd() } } } as unknown as Agent
  return { ctx, home, parent }
}

function execute(ctx: Context, args: unknown, agent: Agent): Promise<ToolExecutionResult> {
  return executeToolFixture(ctx, {
    signal: testToolSignal,
    callId: ToolCallId('pi-call'),
    name: 'pi_agent',
    arguments: args,
    agent,
  })
}

function value(result: ToolExecutionResult): ToolValue {
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  if (result.isError) throw new Error('expected pi_agent success')
  return result.value as ToolValue
}

describe('dsh-pi-agent tool', () => {
  beforeEach(() => { expect(previousHome).toBeUndefined() })

  it('starts a child, reports status with the settled answer, and lists it', async () => {
    const { ctx, parent } = await setup()
    const started = value(await execute(ctx, { op: 'start', task: 'do the thing' }, parent))
    expect(started.kind).toBe('started')
    const childId = started.kind === 'started' ? started.childId : ''
    let status: ToolValue | undefined
    await vi.waitFor(async () => {
      status = value(await execute(ctx, { op: 'status' }, parent))
      expect(status.kind).toBe('status')
      if (status.kind !== 'status') throw new Error('unreachable')
      expect(status.children[0]).toMatchObject({ childId, state: 'idle', lastResult: 'OK: do the thing' })
    })
    const list = value(await execute(ctx, { op: 'list' }, parent))
    if (list.kind !== 'list') throw new Error('unreachable')
    expect(list.children[0]!.childId).toBe(childId)
  })

  it('sends follow-ups to a live child and cold-resumes an inactive child from its session file', async () => {
    const { ctx, parent } = await setup()
    const started = value(await execute(ctx, { op: 'start', task: 'first task' }, parent))
    const childId = started.kind === 'started' ? started.childId : ''
    const sent = value(await execute(ctx, { op: 'send', childId, message: 'HOLD more work' }, parent))
    expect(sent).toMatchObject({ kind: 'sent', childId })
    await vi.waitFor(async () => {
      const status = value(await execute(ctx, { op: 'status', childId }, parent))
      if (status.kind !== 'status') throw new Error('unreachable')
      expect(status.children[0]).toMatchObject({ state: 'running' })
    })
    const interrupted = value(await execute(ctx, { op: 'interrupt', childId }, parent))
    expect(interrupted).toMatchObject({ kind: 'interrupted', childId })

    // simulate a Host restart: a fresh plugin instance reads the durable registry
    const home = process.env.DSH_HOME
    const ctx2 = new Context()
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(NativeToolExecutor)
    await ctx2.plugin(SessionProjectionRegistry)
    provideWorkingDirectoryFixture(ctx2)
    ctx2.provide('llm', { registerAdapter: () => ({ dispose() {}, replace() { return undefined } }) })
    ctx2.provide('agents', { create: async () => ({ agent: { options: {} } }) })
    ctx2.provide('workspaceRegistry', { create: async () => ({ title: '', attachSession: async () => {} }) })
    await ctx2.plugin(piAgent, { command: process.execPath, args: [stubPath], env: {} })
    onTestFinished(async () => {
      await ctx2.fiber.dispose().catch(() => undefined)
    })
    expect(home).toBeDefined()
    const resumed = value(await execute(ctx2, { op: 'send', childId, message: 'continue after restart' }, parent))
    expect(resumed).toMatchObject({ kind: 'sent', childId })
    await vi.waitFor(async () => {
      const status = value(await execute(ctx2, { op: 'status', childId }, parent))
      if (status.kind !== 'status') throw new Error('unreachable')
      expect(status.children[0]).toMatchObject({ childId, state: 'idle', lastResult: 'OK: continue after restart' })
    })
  })

  it('enforces maxChildren against live children', async () => {
    const { ctx, parent } = await setup({ maxChildren: 1 })
    const first = value(await execute(ctx, { op: 'start', task: 'HOLD occupy the slot' }, parent))
    expect(first.kind).toBe('started')
    const blocked = await execute(ctx, { op: 'start', task: 'second task' }, parent)
    expect(blocked.isError).toBe(true)
    if (!blocked.isError) throw new Error('unreachable')
    expect((blocked.content[0] as { text: string }).text).toContain('maxChildren')
  })

  it('rejects unknown children and empty tasks loudly', async () => {
    const { ctx, parent } = await setup()
    const unknown = await execute(ctx, { op: 'send', childId: 'nope', message: 'x' }, parent)
    expect(unknown.isError).toBe(true)
    const empty = await execute(ctx, { op: 'start', task: '' }, parent)
    expect(empty.isError).toBe(true)
  })

  it('fails loudly with install guidance when pi is missing', async () => {
    const { ctx, parent } = await setup({ command: 'definitely-missing-pi-xyz', args: [] })
    const missing = await execute(ctx, { op: 'start', task: 'anything' }, parent)
    expect(missing.isError).toBe(true)
    if (!missing.isError) throw new Error('unreachable')
    expect((missing.content[0] as { text: string }).text).toContain('Install pi')
  })
})

afterEach(() => {
  process.env.DSH_HOME = previousHome
})
