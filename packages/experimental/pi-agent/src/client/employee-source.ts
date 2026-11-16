/**
 * The client-side digital-employee projection: one snapshot of the Host
 * directory shared by every sidebar mark, plus the one-shot creation-request
 * flag that carries a menu activation into the shell-level dialog.
 * @module pi-agent-employee-source
 */

import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EmployeeView } from '../types.ts'

/** One raised dismissal confirmation: the employee to fire and its session. */
export interface DismissRequest {
  readonly employeeId: string
  readonly sessionId: SessionId
  readonly name: string
}

/**
 * Hooks this source exposes to slot components. An object-literal type (not
 * an interface) so the slots framework accepts it as a hooks compartment.
 */
export type EmployeeSourceHooks = {
  /** Directory rows in Host creation order. */
  readonly employees: ObservableSnapshot<readonly EmployeeView[]>
  /** True while the creation wizard's request is up. */
  readonly wizard: ObservableSnapshot<boolean>
  /** The dismissal awaiting confirmation, or null. */
  readonly pendingDismiss: ObservableSnapshot<DismissRequest | null>
  /** The employee under edit, or null. */
  readonly pendingEdit: ObservableSnapshot<{ employeeId: string } | null>
  /** The admin receiving a bound coder, or null. */
  readonly pendingBind: ObservableSnapshot<{ adminId: string } | null>
  /** True from the moment a creation request is accepted until it settles. */
  readonly creating: ObservableSnapshot<boolean>
}

/** The shared employee projection one client instance owns. */
export interface EmployeeSource {
  /** Selector-hook observables injected into slot components. */
  readonly hooks: EmployeeSourceHooks
  /** Replace the directory rows (a settled Host `employee/list` read). */
  adopt(rows: readonly EmployeeView[]): void
  /** Raise or withdraw the creation-wizard request. */
  setWizard(up: boolean): void
  /** Raise the dismissal confirmation. */
  requestDismiss(request: DismissRequest): void
  /** Clear the dismissal confirmation. */
  clearDismiss(): void
  /** Raise the edit dialog for one employee. */
  requestEdit(employeeId: string): void
  /** Clear the edit request. */
  clearEdit(): void
  /** Raise the bind dialog for one admin. */
  requestBind(adminId: string): void
  /** Clear the bind request. */
  clearBind(): void
  /** Raise or clear the creation flag. */
  setCreating(next: boolean): void
}

/** Create the shared projection; the owner refreshes it from the Host. */
export function createEmployeeSource(): EmployeeSource {
  const employees = createSnapshotStore<readonly EmployeeView[]>([])
  const wizard = createSnapshotStore(false)
  const creating = createSnapshotStore(false)
  const pendingDismiss = createSnapshotStore<DismissRequest | null>(null)
  const pendingEdit = createSnapshotStore<{ employeeId: string } | null>(null)
  const pendingBind = createSnapshotStore<{ adminId: string } | null>(null)
  return {
    hooks: { employees, wizard, creating, pendingDismiss, pendingEdit, pendingBind },
    adopt: (rows) => { employees.set(rows) },
    setWizard: (up) => { wizard.set(up) },
    requestDismiss: (request) => { pendingDismiss.set(request) },
    clearDismiss: () => { pendingDismiss.set(null) },
    requestEdit: (employeeId: string) => { pendingEdit.set({ employeeId }) },
    clearEdit: () => { pendingEdit.set(null) },
    requestBind: (adminId: string) => { pendingBind.set({ adminId }) },
    clearBind: () => { pendingBind.set(null) },
    setCreating: (next) => { creating.set(next) },
  }
}
