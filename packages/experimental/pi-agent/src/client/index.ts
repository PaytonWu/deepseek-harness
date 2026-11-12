/**
 * Digital-employee client contributions: the group create-menu row, the
 * creation wizard, and the Session-row avatar mark, over one shared
 * `employee` Remote projection.
 */

import type { Context } from '@deepseek-ai/cordis'
import piRemote from '@deepseek-ai/dsh-pi-agent/remote'
// Type-only: ctx.remote (the employee namespace) on the client root.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: ctx.locale on the client root.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: ctx.slots and the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the 'sidebar.workspaces.group.create.item' and
// 'sidebar.session.row.leading' SlotMap rows and ctx.uiWorkspace.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the 'session' ContextMenuTargetMap row and MenuAction types, and
// ctx.contextMenus on the client root.
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EmployeeCreateRequest } from '../types.ts'
import { createEmployeeSource, type DismissRequest } from './employee-source.ts'
import { CreateEmployeeMenuItem } from './CreateEmployeeMenuItem.tsx'
import { EmployeeCreateDialogHost } from './EmployeeCreateDialog.tsx'
import { EmployeeAvatarBadge } from './EmployeeAvatarBadge.tsx'
import { EmployeeHoverCwd } from './EmployeeHoverCwd.tsx'
import { EmployeeDismissDialogHost } from './EmployeeDismissDialog.tsx'
import { IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { dictionaries, NS, type PiAgentClientKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Digital-employee wizard and avatar copy. */
    'pi-agent': PiAgentClientKey
  }
}

/** Required services: the Remote service, the locale service, and the slot registry. */
export const inject = ['contextMenus', 'locale', 'remote', 'slots']

/**
 * Mount this package's generated Remote namespace, then register the shared
 * employee projection, the create-menu row, the wizard, and the avatar mark.
 * @param ctx - client root context.
 * @returns cleanup for the UI contributions and the Remote mount.
 */
export function apply(ctx: Context): () => Promise<void> {
  const transport = ctx.plugin(async (owner) => { await owner.remote.$mount(piRemote) })
  const ui = ctx.inject(['contextMenus', 'locale', 'remote.employee', 'slots', 'uiWorkspace'], (scope) => {
    scope.effect(() => scope.locale.register(NS, dictionaries), 'pi-agent: dictionaries')
    const source = createEmployeeSource()
    /** Read the directory back; a settled read replaces the projection. */
    const refresh = async (): Promise<void> => {
      const result = await scope.remote.employee.list()
      if (result.ok) source.adopt(result.value)
    }
    void refresh().catch(() => undefined)
    const create = async (request: EmployeeCreateRequest) => {
      source.setCreating(true)
      try {
        const result = await scope.remote.employee.create(request)
        if (result.ok) await refresh()
        return result
      } finally {
        source.setCreating(false)
      }
    }
    scope.effect(() => scope.slots.inject('sidebar.workspaces.group.create.item', () => scope.slots.register({
      name: 'sidebar.workspaces.group.create.item', id: 'pi-coder', order: 10, locale: NS,
      inject: () => ({ openWizard: () => { source.setWizard(true) } }),
    }, CreateEmployeeMenuItem)), 'pi-agent: create-menu row')
    scope.effect(() => scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay', id: 'pi-agent-create-dialog', locale: NS,
      inject: () => ({
        hooks: { wizard: source.hooks.wizard, creating: source.hooks.creating },
        create,
        listModels: () => scope.remote.employee.piModels(),
        pickDirectory: () => scope.uiWorkspace.pickDirectory(),
        openSession: (sessionId: SessionId) => { scope.uiWorkspace.openSession(sessionId) },
        close: () => { source.setWizard(false) },
      }),
    }, EmployeeCreateDialogHost)), 'pi-agent: creation wizard')
    scope.effect(() => scope.slots.inject('sidebar.session.row.leading', () => scope.slots.register({
      name: 'sidebar.session.row.leading', id: 'pi-employee-avatar', order: 20, locale: NS,
      inject: () => ({ hooks: { employees: source.hooks.employees } }),
    }, EmployeeAvatarBadge)), 'pi-agent: avatar mark')
    scope.effect(() => scope.slots.inject('sidebar.session.row.hover', () => scope.slots.register({
      name: 'sidebar.session.row.hover', id: 'pi-employee-cwd', order: 20, locale: NS,
      inject: () => ({ hooks: { employees: source.hooks.employees } }),
    }, EmployeeHoverCwd)), 'pi-agent: hover coding directory')
    scope.effect(() => scope.slots.inject('contextMenu.icon', function* () {
      yield scope.slots.register({ name: 'contextMenu.icon', key: 'pi-agent.dismiss' }, IconTrashOutlineRegular)
    }), 'pi-agent: dismiss icon')
    scope.effect(() => scope.contextMenus.register({
      id: 'employee.dismiss', target: 'session', order: 650,
      observe: () => [source.hooks.employees],
      resolve: (target) => {
        const employee = source.hooks.employees.getSnapshot()
          .find(row => row.sessionId !== undefined && row.sessionId === target.sessionId)
        if (employee === undefined) return []
        const { id: employeeId, sessionId, name } = employee
        if (sessionId === undefined) return []
        return [{
          id: 'dismiss', label: scope.locale.bind(NS)('menu.dismiss'), icon: { key: 'pi-agent.dismiss' },
          danger: true, separatorBefore: true,
          run: () => { source.requestDismiss({ employeeId, sessionId: SessionId(sessionId), name }) },
        }]
      },
    }), 'pi-agent: dismiss menu')
    scope.effect(() => scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay', id: 'pi-agent-dismiss-dialog', locale: NS,
      inject: () => ({
        hooks: { pending: source.hooks.pendingDismiss },
        dismiss: async (request: DismissRequest) => {
          const result = await scope.remote.employee.delete({ id: request.employeeId })
          if (!result.ok) return result
          await scope.uiWorkspace.archiveSession(request.sessionId, { stopActivity: true })
          await refresh()
          return result
        },
        close: () => { source.clearDismiss() },
      }),
    }, EmployeeDismissDialogHost)), 'pi-agent: dismiss dialog')
  })
  return async () => {
    await ui.dispose()
    await transport.dispose()
  }
}
