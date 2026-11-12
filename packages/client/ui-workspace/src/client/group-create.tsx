/**
 * The group-header create menu's close channel: registered create rows call
 * {@link useGroupCreateMenuClose} after activating so the menu dismisses while
 * their own surface (for example a creation dialog) opens.
 * @module @deepseek-ai/dsh-client-ui-workspace/group-create
 */

import { createContext, useContext } from 'react'

/** Provided by the workspace group row around registered create rows. */
export const GroupCreateMenuCloseContext = createContext<() => void>(() => undefined)

/** Read the enclosing group create-menu close callback. */
export function useGroupCreateMenuClose(): () => void {
  return useContext(GroupCreateMenuCloseContext)
}
