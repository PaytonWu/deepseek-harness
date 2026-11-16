/**
 * The employee edit dialog: rename one employee and, for a first-line coder,
 * rebind it to another manager (or unbind). Raised by a shell-level store
 * entry; double-clicking an employee's sidebar row opens it with that employee
 * preselected.
 * @module pi-agent-edit-dialog
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import clsx from 'clsx'
import { Button, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { EmployeeUpdateRequest, EmployeeView } from '../types.ts'
import { NS } from './locales.ts'
import css from './EmployeeCreateDialog.module.css'

/** The edit target: the employee under edit plus the directory rows. */
export interface EditTarget {
  readonly employeeId: string
}

/** Host capabilities the edit dialog needs. */
export interface EmployeeEditDialogInjected {
  /** Shared projection store: `editing` mounts the form; `employees` lists the directory. */
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
 * The edit form: name input plus, for a coder, a manager dropdown (including
 * an unbind row). Save is the single write.
 * @param props.target - the employee under edit.
 * @param props.t - locale seat.
 * @returns the dialog.
 */
function EmployeeEditDialogForm({ target, useEmployees, update, close, t }: EmployeeEditDialogFormProps): ReactNode {
  const employee = useEmployees((rows: readonly EmployeeView[]) => rows.find(row => row.id === target.employeeId))
  const admins = useEmployees((rows: readonly EmployeeView[]) => rows.filter(row => row.type === 'admin'))
  const [name, setName] = useState(employee?.name ?? '')
  const [managerId, setManagerId] = useState<string | undefined>(employee?.managerId)
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  if (employee === undefined) return null

  const save = (): void => {
    const nextName = name.trim()
    if (nextName === employee.name && managerId === employee.managerId) {
      setError(t('edit.nameUnchanged'))
      return
    }
    update({
      id: employee.id,
      ...(nextName !== employee.name && nextName !== '' ? { name: nextName } : {}),
      ...(managerId !== employee.managerId ? { managerId } : {}),
    }).then((result) => {
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      close()
    }).catch((reason: unknown) => { setError(String(reason)) })
  }

  const managerLabel = managerId === undefined
    ? t('edit.managerNone')
    : admins.find(admin => admin.id === managerId)?.name ?? managerId

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
        {employee.type === 'pi-coder' && (
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('edit.field.manager')}</span>
            <Button ref={triggerRef} variant="outline" onClick={() => { setMenuOpen(true) }}>
              <span className={css.selectValue}>{managerLabel}</span>
            </Button>
            <Menu
              open={menuOpen}
              anchor={null}
              anchorRef={triggerRef}
              align="start"
              items={[
                { id: '__none__', label: t('edit.managerNone') },
                ...admins.map(admin => ({ id: admin.id, label: admin.name })),
              ]}
              selectedId={managerId ?? '__none__'}
              onSelect={(id) => { setManagerId(id === '__none__' ? undefined : id); setMenuOpen(false) }}
              onClose={() => { setMenuOpen(false) }}
            />
          </div>
        )}
        {error !== null && <p className={css.error} role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
