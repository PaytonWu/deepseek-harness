/**
 * The digital-employee creation wizard: one shell-level dialog that a group
 * create-menu row raises. Step one picks the employee type (数字程序员 /
 * 数字管理员); the fields adapt per type — an admin carries no working
 * directory (the group directory is fixed) and no manager; a coder offers the
 * directory picker and, with several admins, an explicit manager selection.
 * @module pi-agent-create-dialog
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Button, Input, Menu, type MenuEntry, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EmployeeCreateRequest, EmployeeModelOption, EmployeeView } from '../types.ts'
import { AVATAR_CHOICES, NS, THINKING_CHOICES, type PiAgentClientKey } from './locales.ts'
import css from './EmployeeCreateDialog.module.css'

/** The thinking-strength choice the segmented control edits. */
export type ThinkingChoice = (typeof THINKING_CHOICES)[number]

/** Host capabilities the wizard needs, injected by the plugin entry. */
export interface EmployeeCreateDialogInjected {
  /** Shared projection store: `wizard` mounts the form, `creating` gates the submit affordances.
   * The renderer binds each observable into the component's selector hook prop. */
  readonly hooks: {
    readonly wizard: ObservableSnapshot<boolean>
    readonly creating: ObservableSnapshot<boolean>
    readonly employees: ObservableSnapshot<readonly EmployeeView[]>
  }
  /** Create one employee; the caller refreshes the shared projection. */
  readonly create: (request: EmployeeCreateRequest) => Promise<RemoteResult<EmployeeView>>
  /** List the pi child's selectable models for the model dropdown. */
  readonly listModels: () => Promise<RemoteResult<{ models: readonly EmployeeModelOption[] }>>
  /** Open the Host-native directory picker; null means cancelled. */
  readonly pickDirectory: () => Promise<string | null>
  /** Select a Session and show its Conversation. */
  readonly openSession: (sessionId: SessionId) => void
  /** Withdraw the wizard request the menu row raised. */
  readonly close: () => void
}

/** Full props of the wizard host. */
export type EmployeeCreateDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<EmployeeCreateDialogInjected>

type Translate = PropsLocale<typeof NS>['t']

/**
 * The shell-level wizard host: mounts the form while a creation request is up.
 * @param props.useWizard - whether a creation request is up.
 * @param props.useCreating - creation-in-flight flag.
 * @param props.useEmployees - selector hook over the shared directory rows.
 * @param props.create - `employee/create` bound with the projection refresh.
 * @param props.listModels - `employee/piModels` for the dropdown.
 * @param props.pickDirectory - Host directory picker.
 * @param props.openSession - navigation into the created employee's Session.
 * @param props.close - withdraws the request (cancel and backdrop alike).
 * @param props.t - locale seat.
 * @returns the dialog, or nothing while no request is up.
 */
export function EmployeeCreateDialogHost(props: EmployeeCreateDialogProps): ReactNode {
  const {
    useWizard, useCreating, useEmployees,
    create, listModels, pickDirectory, openSession, close, t,
  } = props
  const up = useWizard(open => open)
  const busy = useCreating(value => value)
  if (!up) return null
  return (
    <EmployeeCreateDialog
      useEmployees={useEmployees}
      busy={busy}
      create={create}
      listModels={listModels}
      pickDirectory={pickDirectory}
      openSession={openSession}
      close={close}
      t={t}
    />
  )
}

interface EmployeeCreateDialogFormProps {
  readonly busy: boolean
  readonly useEmployees: (select: (rows: readonly EmployeeView[]) => readonly EmployeeView[]) => readonly EmployeeView[]
  readonly create: EmployeeCreateDialogInjected['create']
  readonly listModels: EmployeeCreateDialogInjected['listModels']
  readonly pickDirectory: EmployeeCreateDialogInjected['pickDirectory']
  readonly openSession: EmployeeCreateDialogInjected['openSession']
  readonly close: EmployeeCreateDialogInjected['close']
  readonly t: Translate
}

/** The wizard's step state: the type pick, then the per-type fields. */
type WizardKind = 'pick' | 'pi-coder' | 'admin'

/**
 * The form: local state only; Create is the one write. Mounted fresh per
 * request, so each opening starts from the type pick.
 * @param props.busy - whether the creation call is in flight.
 * @param props.t - locale seat.
 * @returns the dialog.
 */
function EmployeeCreateDialog(
  { busy, create, listModels, pickDirectory, openSession, close, t, useEmployees }: EmployeeCreateDialogFormProps,
): ReactNode {
  const [kind, setKind] = useState<WizardKind>('pick')
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<string>(AVATAR_CHOICES[0])
  const [cwd, setCwd] = useState('')
  const [managerId, setManagerId] = useState<string | undefined>(undefined)
  const [model, setModel] = useState<EmployeeModelOption | undefined>(undefined)
  const [thinking, setThinking] = useState<ThinkingChoice>('pi')
  const [models, setModels] = useState<readonly EmployeeModelOption[] | undefined>(undefined)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [managerMenuOpen, setManagerMenuOpen] = useState(false)
  const modelTriggerRef = useRef<HTMLButtonElement>(null)
  const managerTriggerRef = useRef<HTMLButtonElement>(null)
  const thinkingId = useId()
  const admins = useEmployees(rows => rows.filter(row => row.type === 'admin'))

  useEffect(() => {
    let cancelled = false
    listModels().then((result) => {
      if (!cancelled) setModels(result.ok ? result.value.models : [])
    }).catch(() => { cancelled = true })
    return () => { cancelled = true }
  }, [listModels])

  /** Adopt a picked directory; a cancelled pick keeps the typed path. */
  const browse = (): void => {
    pickDirectory().then((picked) => {
      if (picked !== null) setCwd(picked)
    }).catch(() => undefined)
  }

  const submit = (): void => {
    if (kind === 'pick') return
    const directory = kind === 'admin' ? undefined : cwd.trim()
    if (kind === 'pi-coder' && directory === '') {
      setError(t('create.cwdRequired'))
      return
    }
    const resolvedManager = kind === 'pi-coder' && admins.length > 1
      ? managerId ?? admins[0]?.id
      : undefined
    const request: EmployeeCreateRequest = {
      type: kind,
      ...(directory !== undefined ? { cwd: directory } : {}),
      ...(kind === 'admin' ? { channel: 'dingtalk' as const } : {}),
      ...(resolvedManager !== undefined ? { managerId: resolvedManager } : {}),
      avatar,
      ...(name.trim() !== '' ? { name: name.trim() } : {}),
      ...(model !== undefined ? { piModel: { provider: model.provider, modelId: model.modelId } } : {}),
      ...(thinking !== 'pi' ? { thinking } : {}),
    }
    create(request).then((result) => {
      if (!result.ok) {
        setError(`${t('create.error')} ${result.error.message}`)
        return
      }
      // Navigate first: the view switch is the creation's visible feedback, and
      // a navigation failure keeps the dialog up with the error instead of
      // silently closing over an employee the user cannot find.
      if (result.value.sessionId !== undefined) openSession(SessionId(result.value.sessionId))
      close()
    }).catch((reason: unknown) => {
      setError(`${t('create.error')} ${reason instanceof Error ? reason.message : String(reason)}`)
    })
  }

  const [error, setError] = useState<string | null>(null)

  return (
    <Modal
      open
      onClose={close}
      className={clsx(css.dialogWide)}
      title={kind === 'admin' ? t('create.title.admin') : kind === 'pi-coder' ? t('create.title') : t('create.title.pick')}
      closeLabel={t('create.cancel')}
      footer={(
        <>
          <Button variant="outline" onClick={close} disabled={busy}>{t('create.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || kind === 'pick'}>
            {busy ? t('create.submitBusy') : t('create.submit')}
          </Button>
        </>
      )}
    >
      <div className={css.form}>
        {kind === 'pick' && (
          <>
            <p className={css.intro}>{t('create.intro')}</p>
            <div className={css.avatars} role="radiogroup" aria-label={t('create.field.type')}>
              <button type="button" className={css.avatarButton} onClick={() => { setKind('pi-coder'); setAvatar('🧑‍💻') }}>
                <div>🧑‍💻</div>
                <div>{t('create.type.piCoder')}</div>
              </button>
              <button type="button" className={css.avatarButton} onClick={() => { setKind('admin'); setAvatar('🧑‍💼') }}>
                <div>🧑‍💼</div>
                <div>{t('create.type.admin')}</div>
              </button>
            </div>
          </>
        )}
        {kind !== 'pick' && (
          <>
            <p className={css.intro}>{kind === 'admin' ? t('create.intro.admin') : t('create.intro')}</p>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('create.field.name')}</span>
              <Input
                value={name}
                maxLength={60}
                placeholder={t('create.field.namePlaceholder')}
                onChange={(event) => { setName(event.currentTarget.value) }}
              />
            </label>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('create.field.avatar')}</span>
              <div className={css.avatars} role="radiogroup" aria-label={t('create.field.avatar')}>
                {AVATAR_CHOICES.map(choice => (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={choice === avatar}
                    className={choice === avatar ? `${css.avatarButton} ${css.avatarButtonSelected}` : css.avatarButton}
                    onClick={() => { setAvatar(choice) }}
                  >{choice}</button>
                ))}
              </div>
            </div>
            {kind === 'pi-coder' && (
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('create.field.cwd')}</span>
                <div className={css.cwdRow}>
                  <Input
                    className={clsx(css.cwdInput)}
                    value={cwd}
                    placeholder={t('create.field.cwdPlaceholder')}
                    onChange={(event) => { setCwd(event.currentTarget.value); setError(null) }}
                  />
                  <Button variant="outline" onClick={browse}>{t('create.field.cwdPick')}</Button>
                </div>
              </label>
            )}
            {kind === 'pi-coder' && admins.length > 1 && (
              <div className={css.field}>
                <span className={css.fieldLabel}>{t('create.field.manager')}</span>
                <Button
                  ref={managerTriggerRef}
                  variant="outline"
                  onClick={() => { setManagerMenuOpen(true) }}
                >
                  <span className={css.selectValue}>
                    {admins.find(admin => admin.id === (managerId ?? admins[0]?.id))?.name ?? t('create.field.manager')}
                  </span>
                </Button>
                <Menu
                  open={managerMenuOpen}
                  anchor={null}
                  anchorRef={managerTriggerRef}
                  align="start"
                  items={admins.map(admin => ({ id: admin.id, label: admin.name }))}
                  selectedId={managerId ?? admins[0]?.id}
                  onSelect={(id) => { setManagerId(id); setManagerMenuOpen(false) }}
                  onClose={() => { setManagerMenuOpen(false) }}
                />
              </div>
            )}
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('create.field.model')}</span>
              <Button
                ref={modelTriggerRef}
                variant="outline"
                onClick={() => { setModelMenuOpen(true) }}
              >
                <span className={css.selectValue}>{model === undefined ? t('create.field.modelDefault') : model.name}</span>
              </Button>
              <Menu
                open={modelMenuOpen}
                anchor={null}
                anchorRef={modelTriggerRef}
                align="start"
                items={modelMenuItems(models, t)}
                selectedId={model === undefined ? 'default' : `${model.provider}/${model.modelId}`}
                onSelect={(id) => { setModel(modelForId(models, id)); setModelMenuOpen(false) }}
                onClose={() => { setModelMenuOpen(false) }}
              />
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('create.field.thinking')}</span>
              <SegmentedControl
                id={thinkingId}
                label={t('create.field.thinking')}
                value={thinking}
                options={THINKING_CHOICES.map(choice => ({ value: choice, label: t(thinkingLabelKey(choice)) }))}
                onChange={setThinking}
              />
            </div>
            {error !== null && <p className={css.error} role="alert">{error}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}

/** Locale key of one thinking choice's segment label. */
function thinkingLabelKey(choice: ThinkingChoice): PiAgentClientKey {
  return `create.thinking.${choice}` as const
}

/** Dropdown rows: the pi default first, then every selectable pi model. */
function modelMenuItems(models: readonly EmployeeModelOption[] | undefined, t: Translate): MenuEntry[] {
  if (models === undefined) {
    return [
      { id: 'default', label: t('create.field.modelDefault') },
      { id: 'loading', label: t('create.field.modelLoading'), disabled: true },
    ]
  }
  return [
    { id: 'default', label: t('create.field.modelDefault') },
    ...models.map(option => ({
      id: `${option.provider}/${option.modelId}`,
      label: option.name,
      title: `${option.provider}/${option.modelId}`,
    })),
  ]
}

/** Map one dropdown row id back to its model option. */
function modelForId(models: readonly EmployeeModelOption[] | undefined, id: string): EmployeeModelOption | undefined {
  if (id === 'default' || models === undefined) return undefined
  return models.find(option => `${option.provider}/${option.modelId}` === id)
}
