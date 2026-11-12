import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EmployeeDirectoryService } from '../src/employee-directory.ts'
import type { EmployeeCreateRequest } from '../src/types.ts'
import { EmployeeStore } from '../src/employee-store.ts'
import { PI_EMPLOYEE_PROVIDER } from '../src/employee-adapter.ts'

interface AgentCreateCall {
  sessionId: SessionId
  cwd: string
  provider: string
  model: string
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'pi-directory-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const cwd = await mkdir(join(home, 'work'), { recursive: true }).then(() => join(home, 'work'))
  const store = EmployeeStore.load(join(home, 'employees.json'))
  const created: AgentCreateCall[] = []
  const attached: Array<{ workspace: string; sessionId: SessionId }> = []
  const ctx = new Context()
  let createShouldFail: Error | undefined
  ctx.provide('agents', {
    create: async (options: { sessionId: SessionId; meta?: { cwd?: string }; agentOptions?: { provider?: string; model?: string } }) => {
      if (createShouldFail !== undefined) throw createShouldFail
      created.push({ sessionId: options.sessionId, cwd: options.meta?.cwd ?? '', provider: options.agentOptions?.provider ?? '', model: options.agentOptions?.model ?? '' })
      return { agent: { id: options.sessionId, session: { id: options.sessionId }, options: options.agentOptions ?? {} } }
    },
  })
  const workspacePath = join(home, 'pi-agent', 'workspace')
  ctx.provide('workspaceRegistry', {
    create: async () => {
      const sessions: SessionId[] = []
      const workspace = {
        title: '我的数字员工',
        path: workspacePath,
        attachSession: async (sessionId: SessionId) => { attached.push({ workspace: 'group', sessionId }); sessions.push(sessionId) },
      }
      return workspace
    },
  })
  const disposed: string[] = []
  const piModelQueries = { count: 0 }
  const service = new EmployeeDirectoryService(ctx, {
    store,
    disposeChild: async (employeeId) => { disposed.push(employeeId) },
    listPiModels: async () => {
      piModelQueries.count += 1
      return [{ provider: 'stub', modelId: 'stub-chat', name: 'Stub Chat' }]
    },
  }, '我的数字员工')
  onTestFinished(async () => { await ctx.fiber.dispose().catch(() => undefined) })
  const request = (overrides: Partial<EmployeeCreateRequest> = {}): EmployeeCreateRequest => ({
    name: '数字程序员',
    description: 'Writes code.',
    cwd,
    ...overrides,
  })
  const failAgentCreation = (error: Error | undefined): void => { createShouldFail = error }
  return { service, store, created, attached, disposed, cwd, workspacePath, request, failAgentCreation, piModelQueries }
}

describe('EmployeeDirectoryService (T2.1, T2.2, T3.1)', () => {
  it('lists employees in creation order', async () => {
    const { service } = await setup()
    expect(service.list()).toEqual([])
  })

  it('creates an employee with a bound session in the group workspace', async () => {
    const { service, store, created, attached, cwd, workspacePath } = await setup()
    const view = await service.create({ name: '数字程序员', description: 'Writes code.', cwd })
    expect(view.sessionId).toMatch(/^session-/)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ cwd: workspacePath, provider: PI_EMPLOYEE_PROVIDER, model: view.id })
    expect(attached).toEqual([{ workspace: 'group', sessionId: created[0]!.sessionId }])
    expect(store.get(view.id)?.sessionId).toBe(view.sessionId)
  })

  it('maps store validation failures through', async () => {
    const { service, cwd } = await setup()
    await expect(service.create({ cwd: join(cwd, 'missing') })).rejects.toThrow(/cwd/)
    await service.create({ name: '重复名', cwd })
    await expect(service.create({ name: '重复名', cwd })).rejects.toThrow(/exists/)
  })

  it('lists pi models once and caches the result for the Host lifetime (T6.2)', async () => {
    const { service, piModelQueries } = await setup()
    const first = await service.piModels()
    expect(first.models).toEqual([{ provider: 'stub', modelId: 'stub-chat', name: 'Stub Chat' }])
    await service.piModels()
    expect(piModelQueries.count).toBe(1)
  })

  it('creates with wizard fields: type defaults, avatar, model, thinking (T6.3)', async () => {
    const { service, store, cwd } = await setup()
    const view = await service.create({ cwd, name: '小明', avatar: '🤖', piModel: { provider: 'deepseek', modelId: 'deepseek-chat' }, thinking: 'high' })
    expect(view).toMatchObject({ name: '小明', avatar: '🤖', type: 'pi-coder', piModel: { provider: 'deepseek', modelId: 'deepseek-chat' }, thinking: 'high' })
    expect(store.get(view.id)?.description).toContain('数字程序员')
  })

  it('updates and deletes employees, disposing any live child on delete', async () => {
    const { service, disposed, cwd } = await setup()
    const view = await service.create({ name: '数字程序员', description: 'Writes code.', cwd })
    const updated = await service.update({ id: view.id, description: 'Writes better code.' })
    expect(updated.description).toBe('Writes better code.')
    await expect(service.update({ id: 'deadbeef', description: 'x' })).rejects.toThrow(/unknown/)
    await service.delete({ id: view.id })
    expect(service.list()).toEqual([])
    expect(disposed).toEqual([view.id])
    await expect(service.delete({ id: view.id })).rejects.toThrow(/unknown/)
  })
})
