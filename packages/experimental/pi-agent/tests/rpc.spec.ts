import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LineReader, PiMissingError, PiRpcChild } from '../src/rpc.ts'

const stubPath = new URL('./fixtures/stub-pi.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

async function stubOptions(overrides: Partial<Parameters<typeof PiRpcChild.start>[0]> = {}) {
  const sessionDir = await mkdtemp(join(tmpdir(), 'pi-rpc-'))
  onTestFinished(async () => { await rm(sessionDir, { recursive: true, force: true }) })
  return {
    command: process.execPath,
    args: [stubPath],
    cwd: process.cwd(),
    sessionDir,
    env: {},
    ...overrides,
  }
}

describe('LineReader', () => {
  it('splits on LF only, strips CR, and keeps Unicode line separators inside records', () => {
    const reader = new LineReader()
    const records = reader.push(Buffer.from('{"a":1}\r\n{"b":"x\u2028y"}\n{"c":', 'utf8'))
    expect(records).toEqual(['{"a":1}', '{"b":"x\u2028y"}'])
    expect(reader.push(Buffer.from('3}\n'))).toEqual(['{"c":3}'])
    expect(reader.flush()).toEqual([])
  })

  it('flushes one trailing record without a terminator', () => {
    const reader = new LineReader()
    expect(reader.push(Buffer.from('partial'))).toEqual([])
    expect(reader.flush()).toEqual(['partial'])
    expect(reader.flush()).toEqual([])
  })
})

describe('PiRpcChild against the stub', () => {
  it('completes ready, prompt, settle, answer, and dispose', async () => {
    const child = PiRpcChild.start(await stubOptions())
    onTestFinished(() => { void child.dispose() })
    const state = await child.ready()
    expect(state.sessionFile).toContain('stub-')
    expect(child.sessionId).toMatch(/^stub-/)
    expect(await child.sendPrompt('hello')).toBe('started')
    await child.waitSettled()
    expect(child.isStreaming).toBe(false)
    expect(await child.lastAssistantText()).toBe('OK: hello')
    await child.dispose()
    expect(child.hasExited).toBe(true)
  })

  it('resumes an existing session file and reports it back', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'pi-rpc-'))
    onTestFinished(async () => { await rm(sessionDir, { recursive: true, force: true }) })
    const child = PiRpcChild.start(await stubOptions({ sessionFile: join(sessionDir, 'prior.jsonl') }))
    onTestFinished(() => { void child.dispose() })
    const state = await child.ready()
    expect(state.sessionFile).toBe(join(sessionDir, 'prior.jsonl'))
    expect(await child.lastAssistantText()).toBe('RESUMED')
    await child.dispose()
  })

  it('holds a streaming run and ends it through interrupt', async () => {
    const child = PiRpcChild.start(await stubOptions())
    onTestFinished(() => { void child.dispose() })
    await child.ready()
    await child.sendPrompt('HOLD this run')
    expect(child.isStreaming).toBe(true)
    await child.interrupt()
    expect(child.isStreaming).toBe(false)
    expect(await child.lastAssistantText()).toBe('ABORTED')
    await child.dispose()
  })

  it('fails loudly with install guidance when the command is missing', async () => {
    const child = PiRpcChild.start(await stubOptions({ command: 'definitely-missing-pi-xyz', args: [] }))
    onTestFinished(() => { void child.dispose() })
    await expect(child.ready()).rejects.toBeInstanceOf(PiMissingError)
  })
})
