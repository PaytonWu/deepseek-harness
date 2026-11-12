/**
 * The dismissal confirmation for digital employees: one shell-level warning
 * modal that a session context-menu row raises, executing `employee/delete`
 * plus the bound session's archive on confirm.
 * @module pi-agent-dismiss-dialog
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DismissRequest } from './employee-source.ts'
import { NS } from './locales.ts'
import css from './EmployeeCreateDialog.module.css'

/** The dismissal failure surface: the Host answer, ok or the error branch. */
export type DismissResult = RemoteResult<{ deleted: true }>

/** Host capabilities the confirmation needs, injected by the plugin entry. */
export interface EmployeeDismissDialogInjected {
  /** Shared projection store: `pending` mounts the modal. */
  readonly hooks: { readonly pending: ObservableSnapshot<DismissRequest | null> }
  /** Execute one dismissal: `employee/delete`, session archive, projection refresh. */
  readonly dismiss: (request: DismissRequest) => Promise<DismissResult>
  /** Withdraw the confirmation request. */
  readonly close: () => void
}

/** Full props of the confirmation host. */
export type EmployeeDismissDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<EmployeeDismissDialogInjected>

/**
 * The shell-level confirmation host: mounts the modal while a dismissal
 * request is pending.
 * @param props.usePending - the pending dismissal request, or null.
 * @param props.dismiss - executes the dismissal.
 * @param props.close - withdraws the request.
 * @param props.t - locale seat.
 * @returns the modal, or nothing while no request is pending.
 */
export function EmployeeDismissDialogHost({ usePending, dismiss, close, t }: EmployeeDismissDialogProps): ReactNode {
  const pending = usePending(request => request)
  if (pending === null) return null
  return <EmployeeDismissDialog pending={pending} dismiss={dismiss} close={close} t={t} />
}

interface EmployeeDismissDialogFormProps {
  readonly pending: DismissRequest
  readonly dismiss: EmployeeDismissDialogInjected['dismiss']
  readonly close: EmployeeDismissDialogInjected['close']
  readonly t: PropsLocale<typeof NS>['t']
}

/**
 * The confirmation form: Cancel withdraws; the destructive confirm runs the
 * dismissal and closes on success, surfacing failures as an inline error.
 * @param props.pending - the request being confirmed.
 * @param props.t - locale seat.
 * @returns the modal.
 */
function EmployeeDismissDialog({ pending, dismiss, close, t }: EmployeeDismissDialogFormProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = (): void => {
    setBusy(true)
    dismiss(pending).then((result) => {
      if (!result.ok) {
        setBusy(false)
        setError(`${t('dismiss.failed')} ${result.error.message}`)
        return
      }
      close()
    }).catch((reason: unknown) => {
      setBusy(false)
      setError(String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={() => { if (!busy) close() }}
      tone="warning"
      title={t('dismiss.title', { name: pending.name })}
      closeLabel={t('create.cancel')}
      footer={(
        <>
          <Button variant="outline" onClick={close} disabled={busy}>{t('create.cancel')}</Button>
          <Button variant="primary" onClick={confirm} disabled={busy}>{t('dismiss.confirm')}</Button>
        </>
      )}
    >
      <div className={css.form}>
        <p className={css.intro}>{t('dismiss.body')}</p>
        {error !== null && <p className={css.error} role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
