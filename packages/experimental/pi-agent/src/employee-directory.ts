/**
 * The digital-employee directory service: employee CRUD over the durable
 * store, plus the creation orchestration that gives every employee a dsh
 * session inside the "我的数字员工" Workspace group bound to the pi-employee
 * adapter route. Exposed to clients through the Typert gateway.
 * @module pi-employee-directory
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ManagementToolServer, type AdminToolHandlers } from './admin/tool-server.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { PI_EMPLOYEE_PROVIDER } from './employee-adapter.ts'
import type { EmployeeRecord, EmployeeStore } from './employee-store.ts'
import type { EmployeeCreateRequest, EmployeeDeleteRequest, EmployeeUpdateRequest, EmployeeView } from './types.ts'

/** Explicit wiring the service orchestrates against. */
export interface EmployeeDirectoryDeps {
  /** Durable employee store. */
  readonly store: EmployeeStore
  /** Terminate the employee's live pi child, when one exists. */
  readonly disposeChild: (employeeId: string) => Promise<void>
  /** Spawn one short-lived pi child and list its selectable models. */
  readonly listPiModels: () => Promise<readonly { provider: string; modelId: string; name: string }[]>
  /** pi's own config home (trust.json lives here); defaults to `~/.pi/agent`. */
  readonly piAgentHome?: string
  /** Whether an employee currently has a live pi child; powers the status tool. */
  readonly isChildLive?: (employeeId: string) => boolean
  /** Ensure the employee's pi child (dispatch tool injects through it). */
  readonly ensureChild: (employee: EmployeeRecord) => Promise<{ child: { sendPrompt(text: string): Promise<string> } }>
}

/** Employee CRUD and session orchestration over the Typert gateway. */
export class EmployeeDirectoryService extends TypertRemoteService {
  private workspace?: Workspace
  private modelsPromise: Promise<{ models: readonly { provider: string; modelId: string; name: string }[] }> | undefined

  constructor(ctx: Context, private readonly deps: EmployeeDirectoryDeps, private readonly groupTitle: string) {
    super(ctx, 'employee')
  }

  /** Every employee in creation order. */
  @Remote('list')
  list(): EmployeeView[] {
    return this.deps.store.list().map(employeeView)
  }

  /**
   * Validate and persist one employee, then give it a session inside the
   * employee Workspace group bound to the pi-employee adapter route.
   */
  @Remote('create')
  async create(request: EmployeeCreateRequest): Promise<EmployeeView> {
    // The group workspace must exist before any record: admins default their
    // cwd to it (the wizard collects no directory for them).
    const workspace = await this.ensureWorkspace()
    const adminCwd = request.type === 'admin' && request.cwd === undefined
      ? workspace.path
      : undefined
    const employee = await this.deps.store.create(
      adminCwd === undefined ? request : { ...request, cwd: adminCwd },
    )
    // The session's dsh-side cwd is the group workspace directory, because a
    // Workspace accounts sessions by directory; the employee's own cwd is a pi
    // spawn input only and never has to live inside the group directory.
    const sessionId = SessionId(`session-${randomUUID()}`)
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path },
      agentOptions: { provider: PI_EMPLOYEE_PROVIDER, model: employee.id },
    })
    await workspace.attachSession(sessionId)
    this.applySessionTitle(handle.agent.session, employee.name)
    if (employee.type === 'admin') await this.exposeAdminTools(employee.id, workspace.path)
    const bound = await this.deps.store.update(employee.id, { sessionId })
    return employeeView(bound)
  }

  /**
   * List the pi-side models available to employees. The first call spawns a
   * short-lived pi child; the result is cached for the Host lifetime.
   */
  @Remote('piModels')
  async piModels(): Promise<{ models: readonly { provider: string; modelId: string; name: string }[] }> {
    if (this.modelsPromise === undefined) {
      this.modelsPromise = this.queryPiModels().catch((error: unknown) => {
        this.modelsPromise = undefined
        throw error
      })
    }
    return this.modelsPromise
  }

  /** Patch one employee; unknown ids reject. */
  @Remote('update')
  async update(request: EmployeeUpdateRequest): Promise<EmployeeView> {
    return employeeView(await this.deps.store.update(request.id, {
      ...request.name !== undefined ? { name: request.name } : {},
      ...request.description !== undefined ? { description: request.description } : {},
      ...request.cwd !== undefined ? { cwd: request.cwd } : {},
    }))
  }

  /** Remove one employee; its session and pi files stay untouched. */
  @Remote('delete')
  async delete(request: EmployeeDeleteRequest): Promise<{ deleted: true }> {
    await this.deps.disposeChild(request.id)
    await this.deps.store.delete(request.id)
    return { deleted: true }
  }

  /** One management tool server per admin, keyed by admin id. */
  private readonly adminServers = new Map<string, ManagementToolServer>()

  /**
   * Expose the management tools to this admin's pi child: start the MCP tool
   * server (loopback, token path), write a project-local `.pi/mcp.json` into
   * the group workspace, and mark the workspace trusted in pi's own config —
   * otherwise pi ignores project MCP servers in non-interactive sessions.
   */
  private async exposeAdminTools(adminId: string, workspacePath: string): Promise<void> {
    let server = this.adminServers.get(adminId)
    if (server === undefined) {
      server = new ManagementToolServer(adminId, this.adminToolHandlers(adminId))
      const url = await server.start()
      this.adminServers.set(adminId, server)
      this.ctx.logger.info(`pi-agent: admin tool server for ${adminId} at ${url}`)
    }
    const mcpJsonPath = join(workspacePath, '.pi', 'mcp.json')
    await mkdir(join(workspacePath, '.pi'), { recursive: true })
    await writeFileAtomic(mcpJsonPath, `${JSON.stringify({ mcpServers: { 'digital-admin': { url: server.endpoint } } }, undefined, 2)}
`, { mode: 0o600, dirMode: 0o700 })
    const trustPath = join(this.deps.piAgentHome ?? join(homedir(), '.pi', 'agent'), 'trust.json')
    let trust: Record<string, boolean> = {}
    try {
      trust = JSON.parse(readFileSync(trustPath, 'utf8')) as Record<string, boolean>
    } catch {
      trust = {}
    }
    trust[realpathSync(workspacePath)] = true
    await mkdir(this.deps.piAgentHome ?? join(homedir(), '.pi', 'agent'), { recursive: true })
    await writeFileAtomic(trustPath, `${JSON.stringify(trust, undefined, 2)}
`, { mode: 0o600, dirMode: 0o700 })
  }

  /** The management tool endpoint of one admin; unknown id throws. */
  adminToolEndpoint(adminId: string): string {
    const server = this.adminServers.get(adminId)
    if (server === undefined) throw new Error(`pi-agent: admin ${adminId} has no tool server`)
    return server.endpoint
  }

  /** Stop every admin tool server (plugin shutdown). */
  async stopAdminServers(): Promise<void> {
    await Promise.resolve()
    for (const server of this.adminServers.values()) await server.stop()
    this.adminServers.clear()
  }

  /**
   * The tools an admin's pi child may call. Binding and permission checks live
   * here (deterministic code), never in the LLM's discretion; Stage 6 wires
   * the session-backed handlers (dispatch, status).
   */
  private adminToolHandlers(adminId: string): AdminToolHandlers {
    return {
      createEmployee: async (args) => {
        const view = await this.create({ type: 'pi-coder', name: args.name, cwd: args.cwd, managerId: adminId })
        return { id: view.id, name: view.name }
      },
      destroyEmployee: async (args) => {
        const employee = this.deps.store.list().find(row => row.name === args.name || row.id === args.name)
        if (employee === undefined) return { destroyed: false, message: `没有名为「${args.name}」的数字程序员` }
        if (employee.managerId !== adminId) return { destroyed: false, message: `「${employee.name}」不在本管理员的绑定名单中，无法销毁` }
        await this.delete({ id: employee.id })
        return { destroyed: true, message: `已销毁「${employee.name}」` }
      },
      listEmployees: () => Promise.resolve({
        employees: this.deps.store.list()
          .filter(row => row.managerId === adminId)
          .map(row => ({ name: row.name, running: this.deps.isChildLive?.(row.id) === true })),
      }),
      dispatchTask: async ({ employee: employeeName, message }) => {
        const employee = this.deps.store.list().find(row => row.name === employeeName || row.id === employeeName)
        if (employee === undefined) return { dispatched: false, message: `没有名为「${employeeName}」的数字程序员` }
        if (employee.managerId !== adminId) return { dispatched: false, message: `「${employee.name}」不在本管理员的绑定名单中` }
        const { child } = await this.deps.ensureChild(employee)
        await child.sendPrompt(message)
        return { dispatched: true, message: `已派发给「${employee.name}」` }
      },
      employeeStatus: ({ employee: employeeName }) => {
        const employee = this.deps.store.list().find(row => row.name === employeeName || row.id === employeeName)
        if (employee === undefined) return Promise.resolve({ message: `没有名为「${employeeName}」的数字程序员` })
        if (employee.managerId !== adminId) return Promise.resolve({ message: `「${employee.name}」不在本管理员的绑定名单中` })
        const live = this.deps.isChildLive?.(employee.id) === true
        return Promise.resolve({ message: `「${employee.name}」当前${live ? '运行中' : '空闲'}${employee.piSessionFile === undefined ? '（尚未开始第一次对话）' : ''}` })
      },
    }
  }

  /** Spawn one short-lived pi child and ask it for its selectable models. */
  private async queryPiModels(): Promise<{ models: readonly { provider: string; modelId: string; name: string }[] }> {
    const models = await this.deps.listPiModels()
    return { models }
  }

  /**
   * Name the bound session after the employee so the sidebar row reads as the
   * employee, not the default first-turn title. Best effort: a deployment
   * without the title service (or a rejected name) keeps the default title.
   */
  private applySessionTitle(session: Session, name: string): void {
    const titles: SessionTitleService | undefined = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      this.ctx.logger.warn('pi-agent: no sessionTitle service visible from the directory service')
      return
    }
    try {
      titles.rename(session, name)
    } catch (error) {
      // Title is cosmetic: a rename refusal (normalized empty, session not yet
      // live in the title store) must not fail the committed employee creation.
      this.ctx.logger.debug(`pi-agent: session title for employee "${name}" kept default: ${String(error)}`)
    }
  }

  /**
   * Materialize the group Workspace at plugin start (not lazily at the first
   * employee), so its default-blank exclusion holds before any client boots.
   */
  async warmup(): Promise<void> {
    await this.ensureWorkspace()
  }

  /** Resolve the employee group Workspace, creating it once. */
  private async ensureWorkspace(): Promise<Workspace> {
    if (this.workspace !== undefined) return this.workspace
    const path = dshHomePath('pi-agent', 'workspace')
    await mkdir(path, { recursive: true })
    const workspace = await this.ctx.workspaceRegistry.create(path)
    if (workspace.title !== this.groupTitle) await workspace.setTitle(this.groupTitle)
    // The roster group is not a default-blank target: the terminal's implicit
    // new-Session fallbacks must never provision into the employee roster.
    if (!workspace.defaultBlankExcluded) await workspace.setDefaultBlankExcluded(true)
    this.workspace = workspace
    return workspace
  }
}

function employeeView(record: EmployeeRecord): EmployeeView {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    avatar: record.avatar,
    description: record.description,
    cwd: record.cwd,
    ...record.managerId !== undefined ? { managerId: record.managerId } : {},
    ...record.piModel !== undefined ? { piModel: record.piModel } : {},
    ...record.thinking !== undefined ? { thinking: record.thinking } : {},
    ...record.piSessionFile !== undefined ? { piSessionFile: record.piSessionFile } : {},
    ...record.sessionId !== undefined ? { sessionId: record.sessionId } : {},
    createdAt: record.createdAt,
  }
}
