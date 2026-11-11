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
  ctx.provide('workspaceRegistry', {
    create: async () => {
      const sessions: SessionId[] = []
      const workspace = {
        title: '我的数字员工',
        attachSession: async (sessionId: SessionId) => { attached.push({ workspace: 'group', sessionId }); sessions.push(sessionId) },
      }
      return workspace
    },
  })
  const disposed: string[] = []
  const service = new EmployeeDirectoryService(ctx, {
    store,
    disposeChild: async (employeeId) => { disposed.push(employeeId) },
  }, '我的数字员工')
  onTestFinished(async () => { await ctx.fiber.dispose().catch(() => undefined) })
  const request = (overrides: Partial<EmployeeCreateRequest> = {}): EmployeeCreateRequest => ({
    name: '数字程序员',
    description: 'Writes code.',
    cwd,
    ...overrides,
  })
  const failAgentCreation = (error: Error | undefined): void => { createShouldFail = error }
  return { service, store, created, attached, disposed, cwd, request, failAgentCreation }
}

describe('EmployeeDirectoryService (T2.1, T2.2, T3.1)', () => {
  it('lists employees in creation order', async () => {
    const { service } = await setup()
    expect(service.list()).toEqual([])
  })

  it('creates an employee with a bound session in the group workspace', async () => {
    const { service, store, created, attached, cwd } = await setup()
    const view = await service.create({ name: '数字程序员', description: 'Writes code.', cwd })
    expect(view.sessionId).toMatch(/^session-/)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ cwd, provider: PI_EMPLOYEE_PROVIDER, model: view.id })
    expect(attached).toEqual([{ workspace: 'group', sessionId: created[0]!.sessionId }])
    expect(store.get(view.id)?.sessionId).toBe(view.sessionId)
  })

  it('maps store validation failures through', async () => {
    const { service, cwd } = await setup()
    await expect(service.create({ name: '', description: 'd', cwd })).rejects.toThrow(/name/)
    await expect(service.create({ name: 'n', description: ' ', cwd })).rejects.toThrow(/description/)
    await expect(service.create({ name: 'n', description: 'd', cwd: join(cwd, 'missing') })).rejects.toThrow(/cwd/)
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
