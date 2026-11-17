/**
 * The DingTalk channel setup dialog for one digital administrator: dws CLI
 * preflight, notification-group picker, sender-whitelist capture, and save.
 * Raised from the admin session's context menu; persists through the Host so
 * the change survives restarts.
 * @module pi-agent-channel-dialog
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import clsx from 'clsx'
import { Button, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { EmployeeView } from '../types.ts'
import { NS } from './locales.ts'
import css from './EmployeeCreateDialog.module.css'

/** The setup target: the admin whose channel is configured. */
export interface ChannelTarget {
  readonly adminId: string
}

/** Current persisted channel snapshot. */
export interface ChannelSnapshot {
  readonly dingtalkGroupId?: string
  readonly allowedSenderIds: readonly string[]
  readonly capturePending: boolean
  readonly listenerRunning: boolean
}

/** Host channel capabilities the dialog needs. */
export interface ChannelDialogInjected {
  /** Shared projection store: `pendingChannel` mounts the dialog; `employees` resolves names. */
  readonly hooks: {
    readonly pendingChannel: ObservableSnapshot<ChannelTarget | null>
    readonly employees: ObservableSnapshot<readonly EmployeeView[]>
  }
  /** Probe the dws CLI executable and login state. */
  readonly preflight: () => Promise<{ ok: boolean; reason?: string; detail?: string }>
  /** List candidate notification groups. */
  readonly listGroups: () => Promise<readonly { id: string; name: string }[]>
  /** Current persisted channel snapshot. */
  readonly getChannel: () => Promise<ChannelSnapshot>
  /** Persist one group id and restart the listener. */
  readonly saveGroup: (groupId: string) => Promise<unknown>
  /** Begin one sender-capture round. */
  readonly startCapture: () => Promise<unknown>
  /** Abandon a capture round. */
  readonly cancelCapture: () => Promise<unknown>
  /** Withdraw the dialog. */
  readonly close: () => void
}

/** Full props of the channel host. */
export type ChannelSetupDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<Omit<ChannelDialogInjected, 'hooks'> & {
    hooks: {
      readonly pendingChannel: import('@deepseek-ai/dsh-client-store').ObservableSnapshot<ChannelTarget | null>
      readonly employees: import('@deepseek-ai/dsh-client-store').ObservableSnapshot<readonly EmployeeView[]>
    }
  }>

/**
 * The shell-level channel host: mounts the dialog while a target is set.
 * @param props.usePendingChannel - the current channel target (admin), or null.
 * @param props.useEmployees - selector hook over the shared directory rows.
 * @param props.t - locale seat.
 * @returns the dialog, or nothing while no target is pending.
 */
export function ChannelSetupDialogHost(props: ChannelSetupDialogProps): ReactNode {
  const { usePendingChannel, useEmployees, close, t, ...injected } = props
  const target = usePendingChannel(value => value)
  if (target === null) return null
  return (
    <ChannelSetupDialogForm
      target={target}
      useEmployees={useEmployees}
      close={close}
      t={t}
      {...injected}
    />
  )
}

interface ChannelFormProps {
  readonly target: ChannelTarget
  readonly useEmployees: <S>(select: (rows: readonly EmployeeView[]) => S) => S
  readonly preflight: ChannelDialogInjected['preflight']
  readonly listGroups: ChannelDialogInjected['listGroups']
  readonly getChannel: ChannelDialogInjected['getChannel']
  readonly saveGroup: ChannelDialogInjected['saveGroup']
  readonly startCapture: ChannelDialogInjected['startCapture']
  readonly cancelCapture: ChannelDialogInjected['cancelCapture']
  /** Withdraw the dialog. */
  readonly close: () => void
  readonly t: PropsLocale<typeof NS>['t']
}

/**
 * The channel setup form: preflight banner, group picker, whitelist with
 * capture, and one save action that persists and restarts the listener.
 * @param props.target - the admin under configuration.
 * @param props.t - locale seat.
 * @returns the dialog.
 */
function ChannelSetupDialogForm({
  target, useEmployees, preflight, listGroups, getChannel, saveGroup, startCapture, cancelCapture, close, t,
}: ChannelFormProps): ReactNode {
  const admin = useEmployees((rows: readonly EmployeeView[]) => rows.find(row => row.id === target.adminId))
  const [preflightState, setPreflightState] = useState<'loading' | { ok: boolean; reason?: string; detail?: string }>('loading')
  const [groups, setGroups] = useState<readonly { id: string; name: string }[]>([])
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [groupId, setGroupId] = useState<string | undefined>(undefined)
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const groupTriggerRef = useRef<HTMLButtonElement>(null)
  const [whitelist, setWhitelist] = useState<readonly string[]>([])
  const [capturePending, setCapturePending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let disposed = false
    preflight().then((result) => {
      if (disposed) return
      setPreflightState(result)
      if (result.ok) {
        getChannel().then((snapshot) => {
          if (disposed) return
          setGroupId(snapshot.dingtalkGroupId)
          setWhitelist(snapshot.allowedSenderIds)
          setCapturePending(snapshot.capturePending)
        }).catch(() => undefined)
        listGroups().then((rows) => {
          if (!disposed) setGroups(rows)
        }).catch((reason: unknown) => {
          if (!disposed) setGroupsError(String(reason).slice(0, 120))
        })
      }
    }).catch((reason: unknown) => {
      if (!disposed) setPreflightState({ ok: false, reason: 'failed', detail: String(reason).slice(0, 120) })
    })
    return () => { disposed = true }
  }, [preflight, listGroups, getChannel])

  // The capture round settles Host-side; the dialog polls until the round ends.
  useEffect(() => {
    if (!capturePending) return
    const timer = setInterval(() => {
      getChannel().then((snapshot) => {
        setWhitelist(snapshot.allowedSenderIds)
        if (!snapshot.capturePending) setCapturePending(false)
      }).catch(() => undefined)
    }, 2000)
    return () => { clearInterval(timer) }
  }, [capturePending, getChannel])

  const beginCapture = (): void => {
    setNotice(null)
    startCapture().then(() => { setCapturePending(true) }).catch((reason: unknown) => { setNotice(String(reason).slice(0, 120)) })
  }

  const abandonCapture = (): void => {
    cancelCapture().then(() => { setCapturePending(false) }).catch((reason: unknown) => { setNotice(String(reason).slice(0, 120)) })
  }

  const save = (): void => {
    if (groupId === undefined) return
    setSaving(true)
    setNotice(null)
    saveGroup(groupId).then(() => {
      setSaving(false)
      setNotice(t('channel.saved'))
    }).catch((reason: unknown) => {
      setSaving(false)
      setNotice(String(reason).slice(0, 160))
    })
  }

  return (
    <Modal
      open
      onClose={close}
      className={clsx(css.dialogWide)}
      title={t('channel.title', { name: admin?.name ?? '' })}
      closeLabel={t('create.cancel')}
      footer={(
        <>
          <Button variant="outline" onClick={close}>{t('create.cancel')}</Button>
          <Button variant="primary" disabled={groupId === undefined || saving} onClick={save}>
            {saving ? t('channel.saving') : t('channel.save')}
          </Button>
        </>
      )}
    >
      <div className={css.form}>
        {preflightState === 'loading' && <p className={css.intro}>{t('channel.preflight.loading')}</p>}
        {preflightState !== 'loading' && !preflightState.ok && (
          <div className={css.error} role="alert">
            <p>{preflightState.reason === 'missing' ? t('channel.preflight.missing') : preflightState.reason === 'login' ? t('channel.preflight.login') : t('channel.preflight.failed')}</p>
            {preflightState.detail !== undefined && <p>{preflightState.detail}</p>}
          </div>
        )}
        {preflightState !== 'loading' && preflightState.ok && (
          <>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('channel.field.group')}</span>
              <Button
                ref={groupTriggerRef}
                variant="outline"
                onClick={() => { setGroupMenuOpen(true) }}
              >
                <span className={css.selectValue}>
                  {groups.find(group => group.id === groupId)?.name ?? groupId ?? t('channel.group.pick')}
                </span>
              </Button>
              <Menu
                open={groupMenuOpen}
                anchor={null}
                anchorRef={groupTriggerRef}
                align="start"
                items={groupsError !== null ? [] : groups.map(group => ({ id: group.id, label: group.name }))}
                selectedId={groupId}
                onSelect={(id) => { setGroupId(id); setGroupMenuOpen(false) }}
                onClose={() => { setGroupMenuOpen(false) }}
              />
              {groupsError !== null && <p className={css.error}>{t('channel.groups.error', { detail: groupsError })}</p>}
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('channel.field.whitelist')}</span>
              {whitelist.length === 0
                ? <p className={css.intro}>{t('channel.whitelist.empty')}</p>
                : (
                  <ul className={css.team}>
                    {whitelist.map(id => <li key={id} className={css.teamName}>{id}</li>)}
                  </ul>
                )}
              {capturePending
                ? (
                  <div>
                    <p className={css.intro}>{t('channel.capture.waiting')}</p>
                    <Button variant="outline" onClick={abandonCapture}>{t('channel.capture.cancel')}</Button>
                  </div>
                )
                : (
                  <Button variant="outline" onClick={beginCapture}>{t('channel.capture.begin')}</Button>
                )}
              <p className={css.intro}>{t('channel.capture.hint')}</p>
            </div>
            {notice !== null && <p className={css.intro}>{notice}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}
