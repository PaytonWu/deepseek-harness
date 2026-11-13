/**
 * Sidebar hover-card section showing a digital employee's coding directory —
 * the pi working directory, which differs from the Session's own anchored
 * Workspace path (the "我的数字员工" group directory).
 * @module pi-agent-hover-cwd
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { NS } from './locales.ts'
import css from './EmployeeHoverCwd.module.css'

/** Injected share of the hover-card coding-directory section. */
export interface EmployeeHoverCwdInjected {
  /** Directory rows shared by every seat. */
  readonly hooks: { readonly employees: import('@deepseek-ai/dsh-client-store').ObservableSnapshot<readonly import('../types.ts').EmployeeView[]> }
}

/** Full props of the hover-card section. */
export type EmployeeHoverCwdProps =
  PropsRuntime<'sidebar.session.row.hover'>
  & PropsLocale<typeof NS>
  & InjectFace<EmployeeHoverCwdInjected>

/**
 * The employee's coding directory for this Session's hover card.
 * @param props.sessionId - Session the card hovers.
 * @param props.useEmployees - selector hook over the shared directory rows.
 * @param props.t - locale seat.
 * @returns the section, or nothing when no employee owns this Session.
 */
export function EmployeeHoverCwd({ sessionId, useEmployees, t }: EmployeeHoverCwdProps): ReactNode {
  const employee = useEmployees(rows => rows.find(row => row.sessionId === sessionId))
  if (employee === undefined) return null
  return (
    <div className={css.cwd} data-pi-employee-cwd="">
      <span className={css.cwdLabel}>{t('hover.cwd')}</span>
      <span className={css.cwdPath}>{employee.cwd}</span>
    </div>
  )
}
