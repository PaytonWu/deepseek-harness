/**
 * Pure wire types of the digital-employee directory: the one home of the
 * employee view and request shapes, free of host-side value imports.
 * @module @deepseek-ai/dsh-pi-agent/types
 */

/** Client-facing employee record. */
export interface EmployeeView {
  readonly id: string
  readonly type: 'pi-coder' | 'admin'
  /** IM channel of a management-layer employee. */
  readonly channel?: 'dingtalk'
  /** The admin managing this employee; first-line employees only. */
  readonly managerId?: string
  readonly name: string
  readonly avatar: string
  readonly description: string
  readonly cwd: string
  readonly piModel?: { provider: string; modelId: string }
  readonly thinking?: 'off' | 'low' | 'medium' | 'high'
  readonly piSessionFile?: string
  readonly sessionId?: string
  readonly createdAt: string
}

/** One selectable pi model option for an employee. */
export interface EmployeeModelOption {
  readonly provider: string
  readonly modelId: string
  readonly name: string
}

/** One employee creation request. */
export interface EmployeeCreateRequest {
  readonly type?: 'pi-coder' | 'admin'
  /** IM channel; required for an admin, rejected on any other type. */
  readonly channel?: 'dingtalk'
  /** Admin to bind; omitted resolves to the sole admin, ambiguous with many. */
  readonly managerId?: string
  readonly name?: string
  readonly avatar?: string
  readonly description?: string
  /** The wizard omits this for an admin; the orchestration fixes the group directory. */
  readonly cwd?: string
  readonly piModel?: { provider: string; modelId: string }
  readonly thinking?: 'off' | 'low' | 'medium' | 'high'
  readonly piSessionFile?: string
}

/** One employee update request. */
export interface EmployeeUpdateRequest {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly cwd?: string
}

/** One employee deletion request. */
export interface EmployeeDeleteRequest {
  readonly id: string
}
