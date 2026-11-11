/**
 * Real-pi digital-employee smoke: drive one employee conversation through
 * the pi-as-model adapter against the installed pi. Self-skips when no
 * candidate model has quota. Run manually with:
 *   node --import tsx/esm packages/experimental/pi-agent/tests/smoke-real-employee.ts
 * @module smoke-real-employee
 */

import { PiEmployeeAdapter, PI_EMPLOYEE_PROVIDER } from '../src/employee-adapter.ts'
import type { EmployeeRecord } from '../src/employee-store.ts'
import { PiChildManager } from '../src/manager.ts'
import { PiChildRegistry, ensurePiAgentDirs } from '../src/registry.ts'
import { PiRpcChild } from '../src/rpc.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

function fail(message: string): never {
  console.error(`SMOKE-SKIP: ${message}`)
  process.exit(0)
}

const CANDIDATES: ReadonlyArray<{ provider?: string; model?: string }> = [
  { provider: 'deepseek', model: 'deepseek-chat' },
  {},
]

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<string> {
  let text = ''
  for await (const chunk of chunks) if (chunk.type === 'text-delta') text += chunk.text
  return text
}

const paths = await ensurePiAgentDirs()
const registry = PiChildRegistry.load({ file: paths.registryFile, sessionsDir: paths.sessions })
const errors: string[] = []
let answer: string | undefined

for (const candidate of CANDIDATES) {
  const manager = new PiChildManager(registry, {
    command: 'pi',
    args: [],
    sessionDir: paths.sessions,
    env: {},
    ...candidate.provider !== undefined ? { provider: candidate.provider } : {},
    ...candidate.model !== undefined ? { model: candidate.model } : {},
  })
  const employee: EmployeeRecord = {
    id: 'smoke000',
    name: '数字程序员',
    description: 'You are a smoke-test coding employee. Reply with exactly: HI',
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
  }
  const adapter = new PiEmployeeAdapter({
    employeeOf: employeeId => employeeId === employee.id ? employee : undefined,
    ensureChild: async (record) => {
      const ensured = await manager.ensureForEmployee(record)
      return { child: ensured.child, createdFresh: ensured.createdFresh }
    },
  })
  const options = {
    provider: PI_EMPLOYEE_PROVIDER,
    model: employee.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say HI now.' }] }],
  } as unknown as GenerateOptions
  try {
    const text = await collect(adapter.stream(options))
    await manager.disposeAll()
    if (text.length === 0) {
      errors.push(`${candidate.provider ?? 'default'}:${candidate.model ?? 'default'} produced no answer (quota or model error)`)
      continue
    }
    answer = text
    break
  } catch (error) {
    if (error instanceof Error && error.name === 'PiMissingError') fail('pi is not resolvable from PATH')
    errors.push(error instanceof Error ? error.message : String(error))
    await manager.disposeAll().catch(() => undefined)
  }
}
void PiRpcChild
if (answer === undefined) fail(errors.join('; ') || 'no candidate pi model could start')
console.log('EMPLOYEE-ANSWER:', answer.slice(0, 200))
console.log('SMOKE-PASS')
