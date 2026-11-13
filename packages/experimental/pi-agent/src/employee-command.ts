/**
 * The `/new-employee` slash command: the wizard's command form. Parses the
 * employee name plus `--cwd`, `--description`, and `--session` options from
 * the raw input and delegates to the employee directory service.
 * @module pi-employee-command
 */

import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** Parsed `/new-employee` input. */
export interface NewEmployeeInput {
  readonly name: string
  readonly cwd: string
  readonly description: string
  readonly piSessionFile?: string
}

/**
 * Parse one `/new-employee` raw input: a quoted or bare name, then
 * `--cwd`, `--description` (or `--desc`), and `--session` options whose
 * values may be double-quoted.
 * @param raw - text after the command name.
 * @returns the parsed input, or an error message naming the violation.
 */
export function parseNewEmployeeInput(raw: string): NewEmployeeInput | { error: string } {
  const tokens = tokenize(raw)
  const first = tokens[0]
  if (first === undefined || first.value.startsWith('--')) return { error: 'usage: /new-employee <name> [--cwd <dir>] [--description <text>] [--session <file>]' }
  const name = first.value
  const options = new Map<string, string>()
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] as Token
    if (!token.value.startsWith('--')) continue
    const key = token.value === '--desc' ? '--description' : token.value
    const value = tokens.at(index + 1)?.value
    if (value === undefined || value.startsWith('--')) return { error: `option ${key} needs a value` }
    if (options.has(key)) return { error: `option ${key} was given twice` }
    options.set(key, value)
    index += 1
  }
  const cwd = options.get('--cwd')
  if (cwd === undefined || cwd.length === 0) return { error: '--cwd is required: the employee needs a working directory' }
  const description = options.get('--description')
  if (description === undefined || description.trim().length === 0) return { error: '--description is required: the employee needs a responsibility description' }
  const session = options.get('--session')
  return {
    name,
    cwd,
    description,
    ...session !== undefined ? { piSessionFile: session } : {},
  }
}

/** The command definition factory; the create callback owns the orchestration. */
export type NewEmployeeCreateResult = { id: string; name: string; sessionId?: string }

export function newEmployeeCommand(
  create: (input: NewEmployeeInput) => Promise<NewEmployeeCreateResult>,
): CommandDefinition {
  return {
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-pi-agent/new-employee'),
    name: 'new-employee',
    description: 'Create a digital employee (pi coding agent) in the 我的数字员工 group',
    recordInput: false,
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const parsed = parseNewEmployeeInput(invocation.rawInput)
      if ('error' in parsed) return { kind: 'error', text: parsed.error }
      try {
        const view = await create(parsed)
        return {
          kind: 'success',
          text: `数字员工 “${view.name}” 已创建（${view.id}）。会话已加入“我的数字员工”分组；打开它直接对话，任务会由 pi 在 ${parsed.cwd} 中执行。`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

interface Token {
  readonly value: string
  readonly quoted: boolean
}

function tokenize(raw: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < raw.length) {
    while (index < raw.length && /\s/u.test(raw.charAt(index))) index += 1
    if (index >= raw.length) break
    if (raw[index] === '"') {
      const end = raw.indexOf('"', index + 1)
      if (end === -1) return [{ value: raw.slice(index + 1), quoted: true }]
      tokens.push({ value: raw.slice(index + 1, end), quoted: true })
      index = end + 1
      continue
    }
    const start = index
    while (index < raw.length && !/\s/u.test(raw.charAt(index))) index += 1
    tokens.push({ value: raw.slice(start, index), quoted: false })
  }
  return tokens
}
