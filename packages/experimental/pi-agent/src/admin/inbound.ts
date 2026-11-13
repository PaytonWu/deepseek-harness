/**
 * The inbound instruction dispatcher: one whitelisted DingTalk message from
 * the user is injected into the 数字管理员's dsh session (the admin's LLM then
 * decides which tools to call); the settled answer goes back out over the
 * same transport. Per-admin serializes: instructions queue behind the active
 * round instead of interleaving.
 * @module pi-admin-inbound
 */

import type { EmployeeStore } from '../employee-store.ts'
import type { InboundDingtalkMessage } from './dws-transport.ts'

/** The admin session surface the dispatcher injects through. */
export interface AdminSessionHandle {
  /** Inject one user instruction into the admin's pi session. */
  inject(text: string): Promise<void>
  /** The admin's settled answer for this round. */
  answer(): Promise<string>
}

/** Structured logger slice. */
export interface DispatcherLogger {
  warn(message: string): void
}

/** Dispatcher dependencies. */
export interface AdminInboundDispatcherDeps {
  /** The durable directory (employee lookup). */
  readonly store: EmployeeStore
  /** Open the admin's session handle; rejects when the admin is unreachable. */
  readonly ensureForAdmin: (adminId: string) => Promise<AdminSessionHandle>
  /** The channel the reply goes back out on. */
  readonly transport: { send(message: string): Promise<void> }
  /** Whitelisted senders (openDingTalkIds); anyone else is ignored. */
  readonly whitelist: readonly string[]
  /** Structured logger. */
  readonly logger: DispatcherLogger
  /** Whether any admin is currently wired into the IM channel. */
  readonly adminOnline: boolean
}

/**
 * Dispatch one inbound DingTalk message: whitelist → 【-echo guard → serialize
 * per admin → inject → reply. Failures answer back over IM instead of throwing.
 */
export class AdminInboundDispatcher {
  /** Per-admin in-flight round; a second instruction queues behind the first. */
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly deps: AdminInboundDispatcherDeps) {}

  /** Handle one inbound message; never rejects. */
  dispatch(message: InboundDingtalkMessage): Promise<void> {
    return this.dispatchInner(message).catch((reason: unknown) => {
      this.deps.logger.warn(`pi-agent: inbound dispatch failed: ${String(reason)}`)
    })
  }

  private async dispatchInner(message: InboundDingtalkMessage): Promise<void> {
    if (!this.deps.adminOnline) return
    if (!this.deps.whitelist.includes(message.senderId)) return
    // Pipeline notifications echo through the same group; a 【-prefixed text is
    // our own output, never a user instruction.
    if (message.content.startsWith('【')) return
    const admin = this.deps.store.list().find(row => row.type === 'admin')
    if (admin === undefined || admin.channel === undefined) return

    const previous = this.inFlight.get(admin.id) ?? Promise.resolve()
    const round = (async () => {
      await previous.catch(() => undefined)
      let handle: AdminSessionHandle
      try {
        handle = await this.deps.ensureForAdmin(admin.id)
        await handle.inject(message.content)
        const answer = await handle.answer()
        await this.deps.transport.send(answer === '' ? '（本轮无回复）' : answer)
      } catch (error) {
        await this.deps.transport.send(`${tFailure()} ${String(error)}`)
      }
    })()
    this.inFlight.set(admin.id, round)
    try {
      await round
    } finally {
      if (this.inFlight.get(admin.id) === round) this.inFlight.delete(admin.id)
    }
  }

}

/** Localized failure prefix for the IM error notice (single-language v1). */
function tFailure(): string {
  return '【系统】指令处理失败：'
}
