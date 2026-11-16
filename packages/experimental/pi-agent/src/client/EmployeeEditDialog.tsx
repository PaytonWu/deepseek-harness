/**
 * The employee edit dialog: rename one employee. Raised by a shell-level
 * store entry; the employee sidebar row's context menu opens it. Manager
 * rebinding lives on the admin side (the team-management dialog), not here.
 * @module pi-agent-edit-dialog
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { EmployeeUpdateRequest, EmployeeView } from '../types.ts'
import { NS } from './locales.ts'
import css from './EmployeeCreateDialog.module.css'

/** The edit target: the employee under edit. */
export interface EditTarget {
  readonly employeeId: string
}

/** Host capabilities the edit dialog needs. */
export interface EmployeeEditDialogInjected {
  /** Shared projection store: `editing` mounts the form; `employees` resolves the record. */
  readonly hooks: {
    readonly editing: ObservableSnapshot<EditTarget | null>
    readonly employees: ObservableSnapshot<readonly EmployeeView[]>
  }
  /** Apply the patch; the caller refreshes the shared projection. */
  readonly update: (request: EmployeeUpdateRequest) => Promise<RemoteResult<EmployeeView>>
  /** Withdraw the edit request. */
  readonly close: () => void
}

/** Full props of the edit host. */
export type EmployeeEditDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<EmployeeEditDialogInjected>

/**
 * The shell-level edit host: mounts the form while an edit target is set.
 * @param props.useEditing - the current edit target, or null.
 * @param props.useEmployees - selector hook over the shared directory rows.
 * @param props.update - applies the patch.
 * @param props.close - withdraws the edit.
 * @param props.t - locale seat.
 * @returns the dialog, or nothing while no edit is pending.
 */
export function EmployeeEditDialogHost(props: EmployeeEditDialogProps): ReactNode {
  const { useEditing, useEmployees, update, close, t } = props
  const target = useEditing(value => value)
  if (target === null) return null
  return (
    <EmployeeEditDialogForm
      target={target}
      useEmployees={useEmployees}
      update={update}
      close={close}
      t={t}
    />
  )
}

interface EmployeeEditDialogFormProps {
  readonly target: EditTarget
  readonly useEmployees: <S>(select: (rows: readonly EmployeeView[]) => S) => S
  readonly update: EmployeeEditDialogInjected['update']
  readonly close: EmployeeEditDialogInjected['close']
  readonly t: PropsLocale<typeof NS>['t']
}

/**
 * The edit form: name-only rename; Save is the single write.
 * @param props.target - the employee under edit.
 * @param props.t - locale seat.
 * @returns the dialog.
 */
function EmployeeEditDialogForm({ target, useEmployees, update, close, t }: EmployeeEditDialogFormProps): ReactNode {
  const employee = useEmployees((rows: readonly EmployeeView[]) => rows.find(row => row.id === target.employeeId))
  const [name, setName] = useState(employee?.name ?? '')
  const [error, setError] = useState<string | null>(null)

  if (employee === undefined) return null

  const save = (): void => {
    const nextName = name.trim()
    if (nextName === employee.name || nextName === '') {
      setError(t('edit.nameUnchanged'))
      return
    }
    update({ id: employee.id, name: nextName }).then((result) => {
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      close()
    }).catch((reason: unknown) => { setError(String(reason)) })
  }

  return (
    <Modal
      open
      onClose={close}
      className={clsx(css.dialogWide)}
      title={t('edit.title', { name: employee.name })}
      closeLabel={t('create.cancel')}
      footer={(
        <>
          <Button variant="outline" onClick={close}>{t('create.cancel')}</Button>
          <Button variant="primary" onClick={save}>{t('edit.submit')}</Button>
        </>
      )}
    >
      <div className={css.form}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('create.field.name')}</span>
          <Input
            value={name}
            maxLength={60}
            onChange={(event) => { setName(event.currentTarget.value); setError(null) }}
          />
        </label>
        {error !== null && <p className={css.error} role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
