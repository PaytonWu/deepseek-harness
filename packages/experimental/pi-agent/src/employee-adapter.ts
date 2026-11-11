/**
 * The pi digital-employee LLM adapter: one provider route whose "model" is
 * the employee id. Each stream call forwards the last user message to that
 * employee's pi child (injecting the responsibility description into a fresh
 * pi session) and streams the settled pi answer back, so the complete dsh
 * session lifecycle — messages, history, interruption — is reused verbatim.
 * @module pi-employee-adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { EmployeeRecord } from './employee-store.ts'

/** Provider route every employee session selects. */
export const PI_EMPLOYEE_PROVIDER = 'pi-employee'
/** Answers longer than this are refused instead of streamed. */
export const MAX_EMPLOYEE_ANSWER_CHARS = 32_768

/** Dependencies the adapter resolves per call. */
export interface PiEmployeeAdapterDeps {
  /** Resolve the employee record for one model id. */
  readonly employeeOf: (employeeId: string) => EmployeeRecord | undefined
  /** Ensure the employee's pi child is live, creating or cold-resuming it. */
  readonly ensureChild: (employee: EmployeeRecord) => Promise<{ child: EmployeeChildHandle; createdFresh: boolean }>
}

/** Live child surface the adapter consumes. */
export interface EmployeeChildHandle {
  sendPrompt(text: string): Promise<string>
  waitSettled(): Promise<void>
  lastAssistantText(): Promise<string | undefined>
  interrupt(): Promise<void>
}

/** The pi-as-model adapter for digital-employee sessions. */
export class PiEmployeeAdapter extends LlmAdapter {
  constructor(private readonly deps: PiEmployeeAdapterDeps) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: `Digital employee ${model}`,
      context: { contextWindow: 200_000, maxTokens: 32_768 },
      defaultMaxTokens: 8_192,
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const employee = this.deps.employeeOf(options.model)
    if (employee === undefined) throw new Error(`pi-employee: unknown employee "${options.model}"`)
    const text = lastUserText(options)
    if (text.trim().length === 0) throw new Error('pi-employee: the request carries no user text to forward')

    const { child, createdFresh } = await this.deps.ensureChild(employee)
    if (createdFresh) await child.sendPrompt(employee.description)
    await child.sendPrompt(text)

    const onAbort = (): void => { void child.interrupt().catch(() => undefined) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await child.waitSettled()
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
    const answer = (await child.lastAssistantText())?.slice(0, MAX_EMPLOYEE_ANSWER_CHARS) ?? ''

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function lastUserText(options: GenerateOptions): string {
  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index]
    if (message?.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) continue
    return content
      .filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}
