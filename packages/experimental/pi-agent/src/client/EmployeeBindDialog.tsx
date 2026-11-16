/**
 * The team management dialog for a 数字管理员: lists every digital coder
 * with its current binding state and a per-coder bind/unbind toggle.
 * @module pi-agent-bind-dialog
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { EmployeeUpdateRequest, EmployeeView } from '../types.ts'
import { NS } from './locales.ts'
import css from './EmployeeCreateDialog.module.css'

/** The team management target: the admin whose team is being edited. */
export interface BindTarget {
  readonly adminId: string
}

/** Host capabilities the team dialog needs. */
export interface EmployeeBindDialogInjected {
  /** Shared projection store: `binding` mounts the form; `employees` lists the directory. */
  readonly hooks: {
    readonly binding: ObservableSnapshot<BindTarget | null>
    readonly employees: ObservableSnapshot<readonly EmployeeView[]>
  }
  /** Apply the managerId patch; the caller refreshes the shared projection. */
  readonly update: (request: EmployeeUpdateRequest) => Promise<RemoteResult<EmployeeView>>
  /** Withdraw the team dialog. */
  readonly close: () => void
}

/** Full props of the team host. */
export type EmployeeBindDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<EmployeeBindDialogInjected>

/**
 * The shell-level team host: mounts the roster while a bind target is set.
 * @param props.useBinding - the current team target (admin), or null.
 * @param props.useEmployees - selector hook over the shared directory rows.
 * @param props.update - applies the managerId patch.
 * @param props.close - withdraws the dialog.
 * @param props.t - locale seat.
 * @returns the dialog, or nothing while no target is pending.
 */
export function EmployeeBindDialogHost(props: EmployeeBindDialogProps): ReactNode {
  const { useBinding, useEmployees, update, close, t } = props
  const target = useBinding(value => value)
  if (target === null) return null
  return (
    <EmployeeBindDialogForm
      target={target}
      useEmployees={useEmployees}
      update={update}
      close={close}
      t={t}
    />
  )
}

interface EmployeeTeamFormProps {
  readonly target: BindTarget
  readonly useEmployees: <S>(select: (rows: readonly EmployeeView[]) => S) => S
  readonly update: EmployeeBindDialogInjected['update']
  readonly close: EmployeeBindDialogInjected['close']
  readonly t: PropsLocale<typeof NS>['t']
}

/**
 * The team roster: one row per digital coder with a bind/unbind toggle.
 * @param props.target - the admin whose team is managed.
 * @param props.t - locale seat.
 * @returns the dialog.
 */
function EmployeeBindDialogForm({ target, useEmployees, update, close, t }: EmployeeTeamFormProps): ReactNode {
  const coders = useEmployees((rows: readonly EmployeeView[]) => rows.filter(row => row.type === 'pi-coder'))
  const admin = useEmployees((rows: readonly EmployeeView[]) => rows.find(row => row.id === target.adminId))
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = (coder: EmployeeView): void => {
    const bind = coder.managerId !== target.adminId
    setBusyId(coder.id)
    update({ id: coder.id, managerId: bind ? target.adminId : undefined } ).then((result) => {
      setBusyId(null)
      if (!result.ok) setError(result.error.message)
    }).catch((reason: unknown) => {
      setBusyId(null)
      setError(String(reason))
    })
  }

  const adminName = admin?.name ?? ''

  return (
    <Modal
      open
      onClose={close}
      className={clsx(css.dialogWide)}
      title={t('bind.title', { name: adminName })}
      closeLabel={t('create.cancel')}
      footer={(
        <Button variant="outline" onClick={close}>{t('create.cancel')}</Button>
      )}
    >
      <div className={css.form}>
        {coders.length === 0
          ? <p className={css.intro}>{t('bind.empty')}</p>
          : (
            <div className={css.team}>
              {coders.map((coder) => {
                const isMine = coder.managerId === target.adminId
                return (
                  <div key={coder.id} className={css.teamRow}>
                    <span className={css.teamName}>{coder.name}</span>
                    <Button
                      variant={isMine ? 'outline' : 'primary'}
                      onClick={() => { toggle(coder) }}
                      disabled={busyId === coder.id}
                    >
                      {isMine ? t('bind.unbind') : t('bind.action')}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        {error !== null && <p className={css.error} role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
