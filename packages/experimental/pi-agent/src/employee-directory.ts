/**
 * The digital-employee directory service: employee CRUD over the durable
 * store, plus the creation orchestration that gives every employee a dsh
 * session inside the "我的数字员工" Workspace group bound to the pi-employee
 * adapter route. Exposed to clients through the Typert gateway.
 * @module pi-employee-directory
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
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
    const employee = await this.deps.store.create(request)
    // The session's dsh-side cwd is the group workspace directory, because a
    // Workspace accounts sessions by directory; the employee's own cwd is a pi
    // spawn input only and never has to live inside the group directory.
    const workspace = await this.ensureWorkspace()
    const sessionId = SessionId(`session-${randomUUID()}`)
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path },
      agentOptions: { provider: PI_EMPLOYEE_PROVIDER, model: employee.id },
    })
    await workspace.attachSession(sessionId)
    this.applySessionTitle(handle.agent.session, employee.name)
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

  /** The employee group Workspace's id, so clients can scope their own cleanups. */
  @Remote('group')
  async group(): Promise<{ workspaceId?: string }> {
    const workspace = await this.ensureWorkspace()
    return { workspaceId: workspace.id }
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

  /** Resolve the employee group Workspace, creating it once. */
  private async ensureWorkspace(): Promise<Workspace> {
    if (this.workspace !== undefined) return this.workspace
    const path = dshHomePath('pi-agent', 'workspace')
    await mkdir(path, { recursive: true })
    const workspace = await this.ctx.workspaceRegistry.create(path)
    if (workspace.title !== this.groupTitle) await workspace.setTitle(this.groupTitle)
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
    ...record.piModel !== undefined ? { piModel: record.piModel } : {},
    ...record.thinking !== undefined ? { thinking: record.thinking } : {},
    ...record.piSessionFile !== undefined ? { piSessionFile: record.piSessionFile } : {},
    ...record.sessionId !== undefined ? { sessionId: record.sessionId } : {},
    createdAt: record.createdAt,
  }
}
