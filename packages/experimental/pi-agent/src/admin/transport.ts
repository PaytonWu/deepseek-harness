/**
 * The DingTalk channel seam: send to the user's notification group and
 * receive whitelisted inbound instructions. Implementations are swappable —
 * v1 lands on the dws CLI; a enterprise-robot-app implementation later needs
 * only credentials in settings.
 * @module pi-admin-transport
 */

import type { InboundDingtalkMessage } from './dws-transport.ts'

/** The DingTalk channel every admin employee talks through. */
export interface DingtalkTransport {
  /** Send one outbound message (feedback, lifecycle, admin reply). */
  send(message: string): Promise<void>
  /** Start receiving inbound instructions; every callback sees every accepted message. */
  start(receive: (message: InboundDingtalkMessage) => void): Promise<void>
  /** Stop the channel. */
  stop(): Promise<void>
}

/** Narrow a transport to the feedback pipeline's send-only slice. */
export function feedbackTransportOf(transport: DingtalkTransport): { send(message: string): Promise<void> } {
  return { send: message => transport.send(message) }
}
