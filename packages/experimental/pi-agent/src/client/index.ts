/**
 * Digital-employee client contributions: the group create-menu row, the
 * creation wizard, and the Session-row avatar mark, over one shared
 * `employee` Remote projection.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.locale and ctx.remote (with this package's employee namespace) on the client root.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-pi-agent/remote'
// Type-only: ctx.slots and the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the 'sidebar.workspaces.group.create.item' and
// 'sidebar.session.row.leading' SlotMap rows and ctx.uiWorkspace.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
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

/** Required services: the Remote namespace, the locale service, and the slot registry. */
export const inject = ['locale', 'remote', 'slots']

/**
 * Register the shared employee projection, the create-menu row, the wizard,
 * and the avatar mark.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'pi-agent: dictionaries')
  const source = createEmployeeSource()
  /** Read the directory back; a settled read replaces the projection. */
  const refresh = async (): Promise<void> => {
    const result = await ctx.remote.employee.list()
    if (result.ok) source.adopt(result.value)
  }
  void refresh().catch(() => undefined)
  const create = async (request: EmployeeCreateRequest) => {
    source.setCreating(true)
    try {
      const result = await ctx.remote.employee.create(request)
      if (result.ok) await refresh()
      return result
    } finally {
      source.setCreating(false)
    }
  }
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.group.create.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.group.create.item', id: 'pi-coder', order: 10, locale: NS,
    inject: () => ({ openWizard: () => { source.setWizard(true) } }),
  }, CreateEmployeeMenuItem)), 'pi-agent: create-menu row')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'pi-agent-create-dialog', locale: NS,
    inject: () => ({
      hooks: { wizard: source.hooks.wizard, creating: source.hooks.creating },
      create,
      listModels: () => ctx.remote.employee.piModels(),
      pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
      openSession: (sessionId: SessionId) => { ctx.uiWorkspace.openSession(sessionId) },
      close: () => { source.setWizard(false) },
    }),
  }, EmployeeCreateDialogHost)), 'pi-agent: creation wizard')
  ctx.effect(() => ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading', id: 'pi-employee-avatar', order: 20, locale: NS,
    inject: () => ({ hooks: source.hooks }),
  }, EmployeeAvatarBadge)), 'pi-agent: avatar mark')
}
