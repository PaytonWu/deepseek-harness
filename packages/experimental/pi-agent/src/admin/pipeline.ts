/**
 * The feedback pipeline: relays a bound digital programmer's settled answer to
 * the user's DingTalk through the configured transport, and carries lifecycle
 * notices. Never throws to the caller — a transport outage degrades to a log
 * line after retries and the employee keeps working.
 * @module pi-admin-feedback-pipeline
 */

import type { EmployeeStore } from '../employee-store.ts'

/** The DingTalk send surface the pipeline needs (a Transport slice). */
export interface FeedbackTransport {
  send(message: string): Promise<void>
}

/** Structured logger slice. */
export interface PipelineLogger {
  warn(message: string): void
}

/** Feedback answer length cap; longer answers truncate with an omission note. */
export const FEEDBACK_LIMIT = 2000

/** Retry count for one feedback send. */
export const SEND_ATTEMPTS = 3

/**
 * The management-layer relay: one instance per client, driven by the adapter's
 * turn-settle hook and the directory's lifecycle hooks.
 */
export class AdminFeedbackPipeline {
  private readonly retryDelayMs: number

  constructor(private readonly deps: {
    transport: FeedbackTransport
    store: EmployeeStore
    logger: PipelineLogger
    /** Base backoff delay; tests pass 0. */
    retryDelayMs?: number
  }) {
    this.retryDelayMs = deps.retryDelayMs ?? 500
  }

  /**
   * Relay one settled turn of a digital programmer to its manager's user.
   * Silently skips: unknown ids, admins themselves, and unbound coders.
   */
  async onEmployeeTurnSettled(employeeId: string, answer: string): Promise<void> {
    const employee = this.deps.store.get(employeeId)
    if (employee === undefined || employee.type !== 'pi-coder' || employee.managerId === undefined) return
    const body = answer.length > FEEDBACK_LIMIT ? `${answer.slice(0, FEEDBACK_LIMIT)}…（已截断）` : answer
    await this.sendWithRetry(`【${employee.name}】反馈：\n${body}`, employee.name)
  }

  /** Relay one lifecycle notice (employee created/destroyed). */
  async notifyLifecycle(message: string): Promise<void> {
    await this.sendWithRetry(`【系统】${message}`, 'lifecycle')
  }

  /** Send with SEND_ATTEMPTS attempts and exponential backoff; final failure logs. */
  private async sendWithRetry(message: string, subject: string): Promise<void> {
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      try {
        await this.deps.transport.send(message)
        return
      } catch (error) {
        if (attempt === SEND_ATTEMPTS) {
          this.deps.logger.warn(`pi-agent: DingTalk send failed after ${String(SEND_ATTEMPTS)} attempts (${subject}): ${String(error)}`)
          return
        }
        console.error('[send-retry-diag] attempt', String(attempt), 'failed')
        await new Promise<void>((resolve) => { setTimeout(resolve, this.retryDelayMs * 2 ** (attempt - 1)) })
      }
    }
  }
}
