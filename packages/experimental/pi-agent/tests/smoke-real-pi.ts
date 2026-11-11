/**
 * Real-pi end-to-end smoke. Self-skips when pi is missing or every candidate
 * model is unavailable; run manually with:
 *   node --import tsx/esm packages/experimental/pi-agent/tests/smoke-real-pi.ts
 * @module smoke-real-pi
 */

import { PiRpcChild } from '../src/rpc.ts'
import { ensurePiAgentDirs } from '../src/registry.ts'

/** Candidate model overrides tried in order; empty entries keep pi's default. */
const CANDIDATES: ReadonlyArray<{ provider?: string; model?: string }> = [
  { provider: 'deepseek', model: 'deepseek-chat' },
  {},
]

function fail(message: string): never {
  console.error(`SMOKE-SKIP: ${message}`)
  process.exit(0)
}

const paths = await ensurePiAgentDirs()
const errors: string[] = []
let child: PiRpcChild | undefined
let text: string | undefined
for (const candidate of CANDIDATES) {
  try {
    const attempt = PiRpcChild.start({
      command: 'pi',
      args: [],
      cwd: process.cwd(),
      sessionDir: paths.sessions,
      env: {},
      ...candidate.provider !== undefined ? { provider: candidate.provider } : {},
      ...candidate.model !== undefined ? { model: candidate.model } : {},
    })
    const state = await attempt.ready()
    if (state.sessionFile === undefined) {
      errors.push('pi did not report a session file')
      await attempt.dispose()
      continue
    }
    await attempt.sendPrompt('Reply with exactly: OK')
    await attempt.waitSettled()
    const answer = await attempt.lastAssistantText()
    if (answer === undefined || answer.length === 0) {
      errors.push(`${candidate.provider ?? 'default'}:${candidate.model ?? 'default'} produced no answer (model error or quota)`)
      await attempt.dispose()
      continue
    }
    child = attempt
    text = answer
    break
  } catch (error) {
    if (error instanceof Error && error.name === 'PiMissingError') fail('pi is not resolvable from PATH')
    errors.push(error instanceof Error ? error.message : String(error))
  }
}
if (child === undefined || text === undefined) fail(errors.join('; ') || 'no candidate pi model could start')

console.log('sendPrompt: started')
console.log('lastAssistantText:', text)
await child.interrupt().catch(() => undefined)
await child.dispose()
console.log('exited:', child.hasExited)
console.log('SMOKE-PASS')
