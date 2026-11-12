/**
 * The client-side digital-employee projection: one snapshot of the Host
 * directory shared by every sidebar mark, plus the one-shot creation-request
 * flag that carries a menu activation into the shell-level dialog.
 * @module pi-agent-employee-source
 */

import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { EmployeeView } from '../types.ts'

/**
 * Hooks this source exposes to slot components. An object-literal type (not
 * an interface) so the slots framework accepts it as a hooks compartment.
 */
export type EmployeeSourceHooks = {
  /** Directory rows in Host creation order. */
  readonly employees: ObservableSnapshot<readonly EmployeeView[]>
  /** True while the creation wizard's request is up. */
  readonly wizard: ObservableSnapshot<boolean>
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
  /** Raise or clear the creation flag. */
  setCreating(next: boolean): void
}

/** Create the shared projection; the owner refreshes it from the Host. */
export function createEmployeeSource(): EmployeeSource {
  const employees = createSnapshotStore<readonly EmployeeView[]>([])
  const wizard = createSnapshotStore(false)
  const creating = createSnapshotStore(false)
  return {
    hooks: { employees, wizard, creating },
    adopt: (rows) => { employees.set(rows) },
    setWizard: (up) => { wizard.set(up) },
    setCreating: (next) => { creating.set(next) },
  }
}
