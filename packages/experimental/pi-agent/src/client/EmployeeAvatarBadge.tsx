/**
 * Sidebar Session-row avatar mark: the employee emoji of this row's Session.
 * @module pi-agent-avatar-badge
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { NS } from './locales.ts'
import css from './EmployeeAvatarBadge.module.css'

/** Injected share of the avatar mark. */
export interface EmployeeAvatarBadgeInjected {
  /** Directory rows shared by every mark. */
  readonly hooks: { readonly employees: import('@deepseek-ai/dsh-client-store').ObservableSnapshot<readonly import('../types.ts').EmployeeView[]> }
}

/** Full props of the avatar mark. */
export type EmployeeAvatarBadgeProps =
  PropsRuntime<'sidebar.session.row.leading'>
  & PropsLocale<typeof NS>
  & InjectFace<EmployeeAvatarBadgeInjected>

/**
 * The leading-cell emoji of a Session bound to a digital employee.
 * @param props.sessionId - Session this row shows.
 * @param props.useEmployees - selector hook over the shared directory rows.
 * @param props.t - locale seat.
 * @returns the avatar, or nothing when no employee owns this Session.
 */
export function EmployeeAvatarBadge({ sessionId, useEmployees, t }: EmployeeAvatarBadgeProps): ReactNode {
  const employee = useEmployees(rows => rows.find(row => row.sessionId === sessionId))
  if (employee === undefined) return null
  return (
    <span className={css.mark} data-pi-employee-avatar="">
      <span aria-hidden="true">{employee.avatar}</span>
      <span className={css.visuallyHidden}>{t('avatar.aria')}</span>
    </span>
  )
}
