// oxlint-disable typescript/no-unsafe-assignment -- tsc passes strictly; oxlint's
// single-file project service misinfers the CommandDefinition handler's
// cross-package return type around this typed test double.
import { describe, expect, it } from 'vitest'
import { newEmployeeCommand, parseNewEmployeeInput } from '../src/employee-command.ts'
import type { NewEmployeeInput } from '../src/employee-command.ts'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'

function invocation(rawInput: string): CommandInvocation {
  // typed test double: the handler under test reads rawInput only
  // oxlint-disable-next-line @stylistic/max-len
  return { commandId: undefined, agent: undefined, rawInput, attachments: [], signal: new AbortController().signal } as unknown as CommandInvocation
}

describe('parseNewEmployeeInput (T4.2 command form)', () => {
  it('parses a bare name with quoted options', () => {
    const parsed = parseNewEmployeeInput('数字程序员 --cwd "D:\\work" --description "写代码的员工"')
    expect(parsed).toEqual({ name: '数字程序员', cwd: 'D:\\work', description: '写代码的员工' })
  })

  it('parses a quoted name, --desc shorthand, and --session import', () => {
    const parsed = parseNewEmployeeInput('"数字 程序员" --cwd C:/work --desc codes --session C:/prior.jsonl')
    expect(parsed).toEqual({ name: '数字 程序员', cwd: 'C:/work', description: 'codes', piSessionFile: 'C:/prior.jsonl' })
  })

  it('rejects a missing name, missing cwd, and missing description with usage errors', () => {
    expect(parseNewEmployeeInput('')).toMatchObject({ error: expect.stringMatching(/usage/) })
    expect(parseNewEmployeeInput('n --desc d')).toMatchObject({ error: expect.stringMatching(/--cwd/) })
    expect(parseNewEmployeeInput('n --cwd C:/w')).toMatchObject({ error: expect.stringMatching(/--description/) })
  })

  it('rejects an option without a value and a repeated option', () => {
    expect(parseNewEmployeeInput('n --cwd')).toMatchObject({ error: expect.stringMatching(/needs a value/) })
    expect(parseNewEmployeeInput('n --cwd C:/w --cwd D:/x --desc d')).toMatchObject({ error: expect.stringMatching(/twice/) })
  })
})

describe('newEmployeeCommand handler (T4.2)', () => {
  it('creates through the callback and reports success with the employee name', async () => {
    const created: unknown[] = []
    const command = newEmployeeCommand(async (input: NewEmployeeInput) => {
      created.push(input)
      return { id: 'abcd1234', name: input.name, sessionId: 'session-1' }
    })
    await expect(command.handler(invocation('数字程序员 --cwd C:/w --desc codes'))).resolves.toMatchObject({ kind: 'success' })
    expect(created).toEqual([{ name: '数字程序员', cwd: 'C:/w', description: 'codes' }])
  })

  it('maps parse and creation failures to error text', async () => {
    const command = newEmployeeCommand(async (_input: NewEmployeeInput) => { throw new Error('an employee named "x" already exists') })
    await expect(command.handler(invocation('n --desc d'))).resolves.toMatchObject({ kind: 'error', text: expect.stringMatching(/--cwd/) })
    await expect(command.handler(invocation('n --cwd C:/w --desc d'))).resolves.toMatchObject({ kind: 'error', text: expect.stringMatching(/already exists/) })
  })
})
