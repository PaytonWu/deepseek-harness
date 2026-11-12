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
}

/** Employee CRUD and session orchestration over the Typert gateway. */
export class EmployeeDirectoryService extends TypertRemoteService {
  private workspace?: Workspace

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
    await this.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path },
      agentOptions: { provider: PI_EMPLOYEE_PROVIDER, model: employee.id },
    })
    await workspace.attachSession(sessionId)
    const bound = await this.deps.store.update(employee.id, { sessionId })
    return employeeView(bound)
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
    name: record.name,
    description: record.description,
    cwd: record.cwd,
    ...record.piSessionFile !== undefined ? { piSessionFile: record.piSessionFile } : {},
    ...record.sessionId !== undefined ? { sessionId: record.sessionId } : {},
    createdAt: record.createdAt,
  }
}
