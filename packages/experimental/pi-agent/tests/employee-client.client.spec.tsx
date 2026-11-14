// @vitest-environment jsdom
/** Digital-employee client contributions: plugin assembly, the wizard, and the avatar mark. */
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, makeTranslate, RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EmployeeCreateRequest, EmployeeModelOption, EmployeeView } from '../src/types.ts'
import { createEmployeeSource, type EmployeeSource } from '../src/client/employee-source.ts'
import { CreateEmployeeMenuItem } from '../src/client/CreateEmployeeMenuItem.tsx'
import { EmployeeCreateDialogHost } from '../src/client/EmployeeCreateDialog.tsx'
import { EmployeeDismissDialogHost } from '../src/client/EmployeeDismissDialog.tsx'
import type { DismissRequest } from '../src/client/employee-source.ts'
import { EmployeeAvatarBadge } from '../src/client/EmployeeAvatarBadge.tsx'
import { apply as clientApply, inject as clientInject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate({ ...en })

function employee(overrides: Partial<EmployeeView> = {}): EmployeeView {
  return {
    id: 'abcd1234',
    type: 'pi-coder',
    name: '数字程序员',
    avatar: '🧑‍💻',
    description: 'You write code.',
    cwd: 'D:/work',
    createdAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('client plugin assembly', () => {
  /** Mount the client plugin over a real Context with a scripted employee namespace. */
  async function mountPlugin(employees: readonly EmployeeView[] = []) {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: vi.fn(() => () => undefined), bind: () => makeTranslate({ ...en }) } as never)
    ctx.slots.register({ name: 'root', children: {
      'sidebar.workspaces.group.create.item': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'sidebar.session.row.leading': { kind: 'list', scope: 'root' },
    } } as never, () => null)
    const list = vi.fn(async () => ({ ok: true as const, value: [...employees] }))
    new TestRemote(ctx, {
      employee: {
        list,
        create: vi.fn(),
        piModels: vi.fn(async () => ({ ok: true as const, value: { models: [] } })),
      },
    })
    ctx.provide('uiWorkspace', {
      pickDirectory: vi.fn(async () => null),
      archiveSession: vi.fn(async () => undefined),
    } as never)
    const menus: { id: string; resolve: (target: { sessionId: string; displayTitle: string }) => unknown[] }[] = []
    ctx.provide('contextMenus', { register: (contribution: { id: string; resolve: (target: { sessionId: string; displayTitle: string }) => unknown[] }) => { menus.push(contribution); return () => undefined } } as never)
    ctx.provide('workspaces', { list: createSnapshotStore({ items: [], archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready' }) } as never)
    const fiber = await ctx.plugin({ inject: [...clientInject], apply: clientApply })
    return { ctx, fiber, list, menus }
  }

  it('registers the create-menu row, the wizard overlay, and the avatar mark, and reads the directory once', async () => {
    const { ctx, list, menus } = await mountPlugin([employee({ sessionId: 'session-1' })])
    // The contributions mount on the inner fiber once remote.employee unparks.
    await waitFor(() => {
      expect(ctx.slots.entries('sidebar.workspaces.group.create.item').map(entry => entry.options.id)).toEqual(['pi-coder'])
      expect(ctx.slots.entries('shell.overlay').map(entry => entry.options.id))
        .toEqual(['pi-agent-create-dialog', 'pi-agent-dismiss-dialog'])
      expect(ctx.slots.entries('sidebar.session.row.leading').map(entry => entry.options.id)).toEqual(['pi-employee-avatar'])
    })
    await waitFor(() => { expect(list).toHaveBeenCalledOnce() })
    // The Session context menu carries the dismiss row only for employee sessions.
    const dismissMenu = menus.find(menu => menu.id === 'employee.dismiss')
    expect(dismissMenu).toBeDefined()
    const bound = dismissMenu!.resolve({ sessionId: 'session-1', displayTitle: 'x' }) as readonly { id: string }[]
    expect(bound.map(action => action.id)).toEqual(['dismiss'])
    const stranger = dismissMenu!.resolve({ sessionId: 'session-other', displayTitle: 'x' })
    expect(stranger).toEqual([])
  })
})

describe('CreateEmployeeMenuItem', () => {
  it('closes the create menu and raises the wizard request', () => {
    const close = vi.fn()
    const openWizard = vi.fn()
    render(createElement(CreateEmployeeMenuItem, { workspaceId: undefined, label: '我的数字员工', close, openWizard, t } as never))
    fireEvent.click(screen.getByRole('menuitem'))
    expect(close).toHaveBeenCalledOnce()
    expect(openWizard).toHaveBeenCalledOnce()
    expect(screen.getByRole('menuitem').textContent).toContain(en['create.menuItem'])
  })
})

describe('EmployeeAvatarBadge', () => {
  const mount = (source: EmployeeSource, sessionId: SessionId) => render(
    createElement(EmployeeAvatarBadge, {
      sessionId,
      useEmployees: bindSnapshotSelector(source.hooks.employees),
      t,
    } as never),
  )

  it('shows the avatar of the employee bound to this Session', () => {
    const source = createEmployeeSource()
    source.adopt([employee({ avatar: '🐲', sessionId: 'session-1' })])
    mount(source, SessionId('session-1'))
    expect(screen.getByText('🐲')).toBeTruthy()
  })

  it('renders nothing for a Session no employee owns', () => {
    const source = createEmployeeSource()
    source.adopt([employee({ sessionId: 'session-1' })])
    const view = mount(source, SessionId('session-2'))
    expect(view.container.textContent).toBe('')
  })
})

describe('EmployeeCreateDialogHost', () => {
  const models: readonly EmployeeModelOption[] = [
    { provider: 'deepseek', modelId: 'deepseek-chat', name: 'DeepSeek Chat' },
  ]
  type Create = (request: EmployeeCreateRequest) => Promise<RemoteResult<EmployeeView>>

  /** Mount the host over one source and one create stub. */
  function mount(source: EmployeeSource, create: Create = vi.fn<Create>()) {
    const openSession = vi.fn()
    const view = render(createElement(EmployeeCreateDialogHost, {
      useWizard: bindSnapshotSelector(source.hooks.wizard),
      useCreating: bindSnapshotSelector(source.hooks.creating),
      useEmployees: bindSnapshotSelector(source.hooks.employees),
      create,
      listModels: vi.fn(async () => ({ ok: true as const, value: { models } })),
      pickDirectory: vi.fn(async () => null),
      openSession,
      close: () => { source.setWizard(false) },
      t,
    } as never))
    return { view, openSession }
  }

  it('renders nothing while no wizard request is up', () => {
    const source = createEmployeeSource()
    const { view } = mount(source)
    expect(view.container.textContent).toBe('')
  })

  it('submits the five fields and opens the created Session', async () => {
    const source = createEmployeeSource()
    source.setWizard(true)
    const created = employee({ sessionId: 'session-new' })
    const create = vi.fn<Create>(async () => ({ ok: true as const, value: created }))
    const { openSession } = mount(source, create)

    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['create.type.piCoder']) }))
    fireEvent.change(screen.getByPlaceholderText(en['create.field.namePlaceholder']), { target: { value: ' 阿黄 ' } })
    fireEvent.click(screen.getByText('🤖'))
    fireEvent.change(screen.getByPlaceholderText(en['create.field.cwdPlaceholder']), { target: { value: 'D:/repo' } })
    fireEvent.click(screen.getByRole('button', { name: en['create.submit'] }))

    await waitFor(() => { expect(openSession).toHaveBeenCalledWith('session-new' as SessionId) })
    expect(create).toHaveBeenCalledWith({
      type: 'pi-coder',
      name: '阿黄',
      avatar: '🤖',
      cwd: 'D:/repo',
    })
    expect(source.hooks.wizard.getSnapshot()).toBe(false)
  })

  it('omits the name when left empty and lets the Host default apply', async () => {
    const source = createEmployeeSource()
    source.setWizard(true)
    const created = employee({ sessionId: 'session-new' })
    const create = vi.fn<Create>(async () => ({ ok: true as const, value: created }))
    mount(source, create)

    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['create.type.piCoder']) }))
    fireEvent.change(screen.getByPlaceholderText(en['create.field.cwdPlaceholder']), { target: { value: 'D:/repo' } })
    fireEvent.click(screen.getByRole('button', { name: en['create.submit'] }))

    await waitFor(() => { expect(create).toHaveBeenCalled() })
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('name')
  })

  it('requires a working directory before calling the Host', () => {
    const source = createEmployeeSource()
    source.setWizard(true)
    const create = vi.fn<Create>()
    mount(source, create)

    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['create.type.piCoder']) }))
    fireEvent.click(screen.getByRole('button', { name: en['create.submit'] }))
    expect(create).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en['create.cwdRequired'])
  })

  it('shows the Host failure and keeps the wizard up', async () => {
    const source = createEmployeeSource()
    source.setWizard(true)
    const create = vi.fn<Create>(async () => ({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'no such directory', {}),
    }))
    mount(source, create)

    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['create.type.piCoder']) }))
    fireEvent.change(screen.getByPlaceholderText(en['create.field.cwdPlaceholder']), { target: { value: 'D:/gone' } })
    fireEvent.click(screen.getByRole('button', { name: en['create.submit'] }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('no such directory') })
    expect(source.hooks.wizard.getSnapshot()).toBe(true)
  })
})

describe('EmployeeDismissDialogHost', () => {
  type Dismiss = (request: DismissRequest) => Promise<RemoteResult<{ deleted: true }>>

  /** Mount the confirmation host over a pending request. */
  function mount(source: EmployeeSource, dismiss: Dismiss = vi.fn<Dismiss>(async () => ({ ok: true as const, value: { deleted: true } }))) {
    const view = render(createElement(EmployeeDismissDialogHost, {
      usePending: bindSnapshotSelector(source.hooks.pendingDismiss),
      dismiss,
      close: () => { source.clearDismiss() },
      t,
    } as never))
    return { view, dismiss }
  }

  it('renders nothing without a pending request', () => {
    const source = createEmployeeSource()
    const { view } = mount(source)
    expect(view.container.textContent).toBe('')
  })

  it('deletes the employee and archives its session on confirm', async () => {
    const source = createEmployeeSource()
    source.setWizard(false)
    source.requestDismiss({ employeeId: 'abcd1234', sessionId: SessionId('session-1'), name: '数字程序员9' })
    const dismiss = vi.fn<Dismiss>(async () => ({ ok: true as const, value: { deleted: true } }))
    const { openSession } = { openSession: vi.fn() }
    void openSession
    mount(source, dismiss)

    fireEvent.click(screen.getByRole('button', { name: en['dismiss.confirm'] }))
    await waitFor(() => { expect(dismiss).toHaveBeenCalledWith({ employeeId: 'abcd1234', sessionId: SessionId('session-1'), name: '数字程序员9' }) })
    await waitFor(() => { expect(source.hooks.pendingDismiss.getSnapshot()).toBeNull() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the Host failure and keeps the confirmation up', async () => {
    const source = createEmployeeSource()
    source.requestDismiss({ employeeId: 'abcd1234', sessionId: SessionId('session-1'), name: '数字程序员9' })
    const dismiss = vi.fn<Dismiss>(async () => ({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'employee busy', {}),
    }))
    mount(source, dismiss)

    fireEvent.click(screen.getByRole('button', { name: en['dismiss.confirm'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('employee busy') })
    expect(source.hooks.pendingDismiss.getSnapshot()).not.toBeNull()
  })
})
