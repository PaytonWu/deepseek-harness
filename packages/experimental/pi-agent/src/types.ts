/**
 * Pure wire types of the digital-employee directory: the one home of the
 * employee view and request shapes, free of host-side value imports.
 * @module @deepseek-ai/dsh-pi-agent/types
 */

/** Client-facing employee record. */
export interface EmployeeView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly cwd: string
  readonly piSessionFile?: string
  readonly sessionId?: string
  readonly createdAt: string
}

/** One employee creation request. */
export interface EmployeeCreateRequest {
  readonly name: string
  readonly description: string
  readonly cwd: string
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
