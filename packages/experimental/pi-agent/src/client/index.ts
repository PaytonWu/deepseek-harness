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
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EmployeeCreateRequest } from '../types.ts'
import { createEmployeeSource } from './employee-source.ts'
import { CreateEmployeeMenuItem } from './CreateEmployeeMenuItem.tsx'
import { EmployeeCreateDialogHost } from './EmployeeCreateDialog.tsx'
import { EmployeeAvatarBadge } from './EmployeeAvatarBadge.tsx'
import { dictionaries, NS, type PiAgentClientKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Digital-employee wizard and avatar copy. */
    'pi-agent': PiAgentClientKey
  }
}

/** Required services: the Remote service, the locale service, and the slot registry. */
export const inject = ['locale', 'remote', 'slots']

/**
 * Mount this package's generated Remote namespace, then register the shared
 * employee projection, the create-menu row, the wizard, and the avatar mark.
 * @param ctx - client root context.
 * @returns cleanup for the UI contributions and the Remote mount.
 */
export function apply(ctx: Context): () => Promise<void> {
  const transport = ctx.plugin(async (owner) => { await owner.remote.$mount(piRemote) })
  const ui = ctx.inject(['locale', 'remote.employee', 'slots', 'uiWorkspace'], (scope) => {
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
  })
  return async () => {
    await ui.dispose()
    await transport.dispose()
  }
}
