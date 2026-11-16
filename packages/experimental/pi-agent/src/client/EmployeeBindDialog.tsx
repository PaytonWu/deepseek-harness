/**
 * The bind dialog: attach one unbound digital coder to a 数字管理员. Raised
 * from the admin session's context menu; lists every coder without a
 * managerId and writes the binding through the employee update path.
 * @module pi-agent-bind-dialog
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Button, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { EmployeeUpdateRequest, EmployeeView } from '../types.ts'
import { NS } from './locales.ts'
import css from './EmployeeCreateDialog.module.css'

/** The bind target: the admin receiving a coder. */
export interface BindTarget {
  readonly adminId: string
}

/** Host capabilities the bind dialog needs. */
export interface EmployeeBindDialogInjected {
  /** Shared projection store: `binding` mounts the form; `employees` lists the directory. */
  readonly hooks: {
    readonly binding: ObservableSnapshot<BindTarget | null>
    readonly employees: ObservableSnapshot<readonly EmployeeView[]>
  }
  /** Apply the managerId patch; the caller refreshes the shared projection. */
  readonly update: (request: EmployeeUpdateRequest) => Promise<RemoteResult<EmployeeView>>
  /** Withdraw the bind request. */
  readonly close: () => void
}

/** Full props of the bind host. */
export type EmployeeBindDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<EmployeeBindDialogInjected>

/**
 * The shell-level bind host: mounts the picker while a bind target is set.
 * @param props.useBinding - the current bind target (admin), or null.
 * @param props.useEmployees - selector hook over the shared directory rows.
 * @param props.update - applies the managerId patch.
 * @param props.close - withdraws the bind.
 * @param props.t - locale seat.
 * @returns the dialog, or nothing while no bind is pending.
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

interface EmployeeBindDialogFormProps {
  readonly target: BindTarget
  readonly useEmployees: <S>(select: (rows: readonly EmployeeView[]) => S) => S
  readonly update: EmployeeBindDialogInjected['update']
  readonly close: EmployeeBindDialogInjected['close']
  readonly t: PropsLocale<typeof NS>['t']
}

/**
 * The bind form: a dropdown of every coder without a manager, bound to this
 * admin on save. Empty state names the reason.
 * @param props.target - the admin receiving the coder.
 * @param props.t - locale seat.
 * @returns the dialog.
 */
function EmployeeBindDialogForm({ target, useEmployees, update, close, t }: EmployeeBindDialogFormProps): ReactNode {
  const admin = useEmployees((rows: readonly EmployeeView[]) => rows.find(row => row.id === target.adminId))
  const unbound = useEmployees((rows: readonly EmployeeView[]) => rows.filter(row => row.type === 'pi-coder' && row.managerId === undefined))
  const [employeeId, setEmployeeId] = useState<string | undefined>(unbound[0]?.id)
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  if (admin === undefined) return null

  const save = (): void => {
    if (employeeId === undefined) return
    update({ id: employeeId, managerId: admin.id }).then((result) => {
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      close()
    }).catch((reason: unknown) => { setError(String(reason)) })
  }

  const chosen = unbound.find(row => row.id === employeeId)

  return (
    <Modal
      open
      onClose={close}
      className={clsx(css.dialogWide)}
      title={t('bind.title', { name: admin.name })}
      closeLabel={t('create.cancel')}
      footer={(
        <>
          <Button variant="outline" onClick={close}>{t('create.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={employeeId === undefined}>{t('bind.submit')}</Button>
        </>
      )}
    >
      <div className={css.form}>
        {unbound.length === 0
          ? <p className={css.intro}>{t('bind.empty')}</p>
          : (
            <div className={css.field}>
              <Button ref={triggerRef} variant="outline" onClick={() => { setMenuOpen(true) }}>
                <span className={css.selectValue}>{chosen?.name ?? t('bind.none')}</span>
              </Button>
              <Menu
                open={menuOpen}
                anchor={null}
                anchorRef={triggerRef}
                align="start"
                items={unbound.map(row => ({ id: row.id, label: row.name }))}
                selectedId={employeeId}
                onSelect={(id) => { setEmployeeId(id); setMenuOpen(false) }}
                onClose={() => { setMenuOpen(false) }}
              />
            </div>
          )}
        {error !== null && <p className={css.error} role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
