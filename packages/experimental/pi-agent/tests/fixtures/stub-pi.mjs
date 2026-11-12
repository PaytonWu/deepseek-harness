/**
 * Deterministic pi RPC stub for unit tests. Speaks the command subset the
 * plugin consumes. A prompt starting with `HOLD` starts a run that streams
 * until `abort`; any other prompt settles immediately. Usage:
 *   node stub-pi.mjs --mode rpc --session-dir <dir> [--session <file>]
 * @module stub-pi
 */

import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const argv = process.argv.slice(2)
function argValue(name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const sessionDir = argValue('--session-dir') ?? '.'
const resumed = argValue('--session')
const sessionFile = resumed ?? join(sessionDir, `stub-${randomUUID()}.jsonl`)
const sessionId = `stub-${randomUUID().slice(0, 8)}`
writeFileSync(sessionFile, `{"stub":true,"resumed":${resumed !== undefined}}\n`)

let streaming = false
let answer = resumed === undefined ? null : 'RESUMED'
let thinkingLevel = 'medium'

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

function respond(id, command, data = {}) {
  send({ id, type: 'response', command, success: true, data })
}

process.stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8')
  let start = 0
  while (start < text.length) {
    const end = text.indexOf('\n', start)
    const line = (end === -1 ? text.slice(start) : text.slice(start, end)).replace(/\r$/, '')
    if (end === -1) break
    start = end + 1
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    handle(record)
  }
})

function handle(record) {
  switch (record.type) {
    case 'get_state':
      respond(record.id, 'get_state', { isStreaming: streaming, sessionId, sessionFile, messageCount: 1 })
      break
    case 'prompt': {
      const message = typeof record.message === 'string' ? record.message : ''
      respond(record.id, 'prompt', { disposition: streaming ? 'queued' : 'started' })
      send({ type: 'agent_start' })
      if (message.startsWith('HOLD')) {
        streaming = true
      } else {
        answer = `OK: ${message}`
        send({ type: 'agent_settled', aborted: false })
      }
      break
    }
    case 'clear_queue':
      respond(record.id, 'clear_queue', { steering: [], followUp: [] })
      break
    case 'abort':
      respond(record.id, 'abort', {})
      if (streaming) {
        streaming = false
        answer = 'ABORTED'
        send({ type: 'agent_settled', aborted: true })
      }
      break
    case 'get_available_models':
      respond(record.id, 'get_available_models', { models: [
        { id: 'stub-chat', name: 'Stub Chat', provider: 'stub' },
        { id: 'stub-reasoner', name: 'Stub Reasoner', provider: 'stub' },
      ] })
      break
    case 'set_thinking_level':
      thinkingLevel = record.level
      respond(record.id, 'set_thinking_level', {})
      break
    case 'get_last_assistant_text':
      respond(record.id, 'get_last_assistant_text', { text: answer })
      break
    default:
      send({ id: record.id, type: 'response', command: record.type, success: false, error: { message: `unsupported command ${String(record.type)}` } })
  }
}
