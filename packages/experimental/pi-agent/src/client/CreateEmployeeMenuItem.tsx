/**
 * The group-header create-menu row that opens the digital-coder wizard.
 * @module pi-agent-create-menu-item
 */

import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.workspaces.group.create.item' SlotMap row (its owner
// share carries this menu's close callback).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { AVATAR_CHOICES, NS } from './locales.ts'

/** Injected share of the create-menu row. */
export interface CreateEmployeeMenuItemInjected {
  /** Raise the creation request the shell-level dialog answers. */
  readonly openWizard: () => void
}

/** Full props of the create-menu row. */
export type CreateEmployeeMenuItemProps =
  PropsRuntime<'sidebar.workspaces.group.create.item'>
  & PropsLocale<typeof NS>
  & InjectFace<CreateEmployeeMenuItemInjected>

/**
 * The “digital coder” row in a Workspace group header's create menu.
 * @param props.close - dismisses the create menu (owner share).
 * @param props.openWizard - raises the creation request.
 * @param props.t - locale seat.
 * @returns the menu row.
 */
export function CreateEmployeeMenuItem({ close, openWizard, t }: CreateEmployeeMenuItemProps) {
  return (
    <MenuItemButton
      icon={<span aria-hidden="true">{AVATAR_CHOICES[0]}</span>}
      onSelect={() => { close(); openWizard() }}
    >
      {t('create.menuItem')}
    </MenuItemButton>
  )
}
