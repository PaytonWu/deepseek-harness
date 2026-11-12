import { describe, expect, it } from 'vitest'
import { PiEmployeeAdapter, PI_EMPLOYEE_PROVIDER } from '../src/employee-adapter.ts'
import type { EmployeeChildHandle } from '../src/employee-adapter.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { EmployeeRecord } from '../src/employee-store.ts'

function employee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    id: 'abcd1234',
    name: '数字程序员',
    description: 'You write code.',
    cwd: 'D:/work',
    createdAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  }
}

function stubChild(answer: string): EmployeeChildHandle & { sent: string[]; interrupted: number } {
  return {
    sent: [],
    interrupted: 0,
    sendPrompt(text: string) { this.sent.push(text); return Promise.resolve('started') },
    waitSettled: () => Promise.resolve(),
    lastAssistantText: () => Promise.resolve(answer),
    interrupt() { this.interrupted += 1; return Promise.resolve() },
  }
}

function generateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: PI_EMPLOYEE_PROVIDER,
    model: 'abcd1234',
    messages: [
      { role: 'system', content: '' },
      { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
    ],
    ...overrides,
  } as GenerateOptions
}

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const collected: StreamChunk[] = []
  for await (const chunk of chunks) collected.push(chunk)
  return collected
}

describe('PiEmployeeAdapter (T3.2, T3.3, T3.5, T3.6, T3.8)', () => {
  it('forwards the last user text and streams the pi answer back as text', async () => {
    const child = stubChild('DONE')
    const adapter = new PiEmployeeAdapter({
      employeeOf: () => employee(),
      ensureChild: () => Promise.resolve({ child, createdFresh: false }),
    })
    const chunks = await collect(adapter.stream(generateOptions()))
    expect(child.sent).toEqual(['do the thing'])
    const deltas = chunks.filter((chunk): chunk is { type: 'text-delta'; index: number; text: string } => chunk.type === 'text-delta')
    expect(deltas.map(chunk => chunk.text).join('')).toBe('DONE')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('skips injected runtime-context snapshots and forwards the real user text', async () => {
    const child = stubChild('OK')
    const adapter = new PiEmployeeAdapter({
      employeeOf: () => employee(),
      ensureChild: () => Promise.resolve({ child, createdFresh: false }),
    })
    const options = generateOptions()
    ;(options.messages as unknown[]).push({
      role: 'user',
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }],
      source: { kind: 'runtime-context' },
    })
    await collect(adapter.stream(options))
    expect(child.sent).toEqual(['do the thing'])
  })

  it('injects the responsibility description before the first user text on a fresh session', async () => {
    const child = stubChild('OK')
    const adapter = new PiEmployeeAdapter({
      employeeOf: () => employee(),
      ensureChild: () => Promise.resolve({ child, createdFresh: true }),
    })
    await collect(adapter.stream(generateOptions()))
    expect(child.sent).toEqual(['You write code.', 'do the thing'])
  })

  it('skips the description when resuming a bound session', async () => {
    const child = stubChild('OK')
    const adapter = new PiEmployeeAdapter({
      employeeOf: () => employee({ piSessionFile: 'C:/prior.jsonl' }),
      ensureChild: () => Promise.resolve({ child, createdFresh: false }),
    })
    await collect(adapter.stream(generateOptions()))
    expect(child.sent).toEqual(['do the thing'])
  })

  it('rejects an unknown employee model id', async () => {
    const adapter = new PiEmployeeAdapter({ employeeOf: () => undefined, ensureChild: () => { throw new Error('unreachable') } })
    await expect(collect(adapter.stream(generateOptions()))).rejects.toThrow(/unknown employee/)
  })

  it('interrupts the pi child when the request signal aborts', async () => {
    const controller = new AbortController()
    const child = stubChild('PARTIAL')
    child.waitSettled = () => new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => { resolve() })
    })
    const adapter = new PiEmployeeAdapter({
      employeeOf: () => employee(),
      ensureChild: () => Promise.resolve({ child, createdFresh: false }),
    })
    const pending = collect(adapter.stream(generateOptions({ signal: controller.signal })))
    await new Promise((resolve) => { setImmediate(resolve) })
    controller.abort()
    await pending
    expect(child.interrupted).toBe(1)
  })

  it('bounds the streamed answer', async () => {
    const child = stubChild('x'.repeat(40_000))
    const adapter = new PiEmployeeAdapter({
      employeeOf: () => employee(),
      ensureChild: () => Promise.resolve({ child, createdFresh: false }),
    })
    const chunks = await collect(adapter.stream(generateOptions()))
    const deltas = chunks.filter((chunk): chunk is { type: 'text-delta'; index: number; text: string } => chunk.type === 'text-delta')
    expect(deltas[0]!.text.length).toBe(32_768)
  })
})
