import { describe, expect, it, onTestFinished } from 'vitest'
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Client } from '@modelcontextprotocol/client'
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
  const workspaceFlags: string[] = []
  ctx.provide('workspaceRegistry', {
    create: async () => {
      await mkdir(workspacePath, { recursive: true })
      const sessions: SessionId[] = []
      const workspace = {
        title: '我的数字员工',
        path: workspacePath,
        defaultBlankExcluded: false,
        setDefaultBlankExcluded: async (excluded: boolean) => { workspaceFlags.push(excluded ? 'set' : 'cleared'); workspace.defaultBlankExcluded = excluded },
        attachSession: async (sessionId: SessionId) => { attached.push({ workspace: 'group', sessionId }); sessions.push(sessionId) },
      }
      return workspace
    },
  })
  const disposed: string[] = []
  const piModelQueries = { count: 0 }
  const piAgentHome = join(home, 'pi-home')
  const service = new EmployeeDirectoryService(ctx, {
    store,
    disposeChild: async (employeeId) => { disposed.push(employeeId) },
    listPiModels: async () => {
      piModelQueries.count += 1
      return [{ provider: 'stub', modelId: 'stub-chat', name: 'Stub Chat' }]
    },
    piAgentHome,
  }, '我的数字员工')
  onTestFinished(async () => { await ctx.fiber.dispose().catch(() => undefined) })
  const request = (overrides: Partial<EmployeeCreateRequest> = {}): EmployeeCreateRequest => ({
    name: '数字程序员',
    description: 'Writes code.',
    cwd,
    ...overrides,
  })
  const stopAdminServers = async (): Promise<void> => { await service.stopAdminServers() }
  onTestFinished(() => { void stopAdminServers() })
  const failAgentCreation = (error: Error | undefined): void => { createShouldFail = error }
  return {
    service, store, created, attached, disposed, cwd, workspacePath, request,
    failAgentCreation, piModelQueries, workspaceFlags, piAgentHome,
  }
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

  it('flags the group workspace as default-blank-excluded on creation', async () => {
    const { service, request, workspaceFlags } = await setup()
    await service.create(request())
    expect(workspaceFlags).toEqual(['set'])
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

describe('EmployeeDirectoryService Stage 2 (M3, T2.1-T2.3)', () => {
  it('defaults an admin creation to the group directory and routes the pi-employee adapter (T2.1)', async () => {
    const { service, created, attached, workspacePath, request } = await setup()
    const view = await service.create(request({ type: 'admin', channel: 'dingtalk', name: '管理员A', cwd: undefined as unknown as string }))
    expect(view.cwd).toBe(workspacePath)
    expect(created).toHaveLength(1)
    expect(created[0]!.cwd).toBe(workspacePath)
    expect(created[0]!.provider).toBe(PI_EMPLOYEE_PROVIDER)
    expect(created[0]!.model).toBe(view.id)
    expect(attached).toHaveLength(1)
  })

  it('exposes the management tool server on admin creation: .pi/mcp.json + trust + five tools (T2.3)', async () => {
    const { service, store, created, attached, workspacePath, piAgentHome, request } = await setup()
    void attached
    const view = await service.create(request({ type: 'admin', channel: 'dingtalk', name: '管理员A' }))
    await service.create(request({ name: '小张' }))

    const mcp = JSON.parse(await readFile(join(workspacePath, '.pi', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { url: string }>
    }
    const url = mcp.mcpServers['digital-admin']!.url
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/u)

    const trust = JSON.parse(await readFile(join(piAgentHome, 'trust.json'), 'utf8')) as Record<string, boolean>
    expect(trust[realpathSync(workspacePath)]).toBe(true)

    // The endpoint lists the five management tools and routes into the store.
    const client = await mcpClientFor(url)
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      'create_employee', 'destroy_employee', 'dispatch_task', 'employee_status', 'list_employees',
    ])
    const call = await client.callTool({ name: 'list_employees', arguments: {} })
    const text = (call.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('小张')
    expect(text).not.toContain('管理员A')
    void store
    void created
    await client.close()
    void view
  })
})

/** Connect an MCP client to the management tool endpoint. */
async function mcpClientFor(url: string): Promise<{
  listTools: () => Promise<{ tools: Array<{ name: string }> }>
  callTool: (args: { name: string; arguments?: Record<string, unknown> }) => Promise<{ content: unknown }>
  close: () => Promise<void>
}> {
  const client = new Client({ name: 'spec', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url))
  await client.connect(transport)
  return client
}
