/**
 * One-shot live driver against the running `dsh web` Host: authenticate with
 * the printed token URL, create a Session, send a prompt that instructs the
 * model to use the pi_agent tool, then poll the Session page until the turn
 * completes. Usage:
 *   node --import tsx/esm apps/web/tests/pi-agent-live.ts <http-url-with-token>
 * @module pi-agent-live
 */

import { randomUUID } from 'node:crypto'

const launchUrl = process.argv[2]
if (launchUrl === undefined) {
  console.error('usage: pi-agent-live.ts <http://127.0.0.1:3080/?token=...>')
  process.exit(1)
}

const origin = new URL(launchUrl).origin
const boot = await fetch(launchUrl, { redirect: 'manual' })
const setCookie = boot.headers.get('set-cookie')
if (boot.status !== 303 || setCookie === null) throw new Error(`auth failed: HTTP ${String(boot.status)}`)
const cookie = setCookie.split(';', 1)[0]!

async function rpc<T>(method: string, args: object): Promise<T> {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  })
  if (!response.ok) throw new Error(`${method} HTTP ${String(response.status)}: ${await response.text()}`)
  const body = await response.json() as { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }
  if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

interface PageRecord {
  type: 'event' | 'chunks'
  event: { type?: string; data?: unknown }
}

const created = await rpc<{ sessionId: string }>('session/create', { request: {} })
console.log('sessionId:', created.sessionId)
const selected = await rpc<{ selected: { provider: string; model: string } }>('session/selectModel', { request: { sessionId: created.sessionId, provider: 'deepseek-account', model: 'deepseek-flash' } })
console.log('model:', selected.selected.provider, selected.selected.model)
const prompt = [
  'Use the pi_agent tool now:',
  "1) op=start with task='Reply with exactly: OK'.",
  '2) poll op=status (up to 10 times, a few seconds apart) until the child state is idle.',
  '3) Answer with exactly three lines: CHILD_ID: <id>, STATE: <state>, RESULT: <lastResult>.',
].join(' ')
await rpc<{ accepted: true }>('session/prompt', { request: {
  requestId: randomUUID(),
  sessionId: created.sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: prompt }],
} })
console.log('prompt accepted; polling the session page for the final answer...')

const deadline = Date.now() + 300_000
const throughSeq = 0
let sawAnswer = false
while (Date.now() < deadline) {
  await new Promise((resolve) => { setTimeout(resolve, 4_000) })
  const page = await rpc<{ records: PageRecord[]; hasMore: boolean }>('session/page', {
    request: { address: { kind: 'session', sessionId: created.sessionId }, throughSeq, maxMessages: 50 },
  })
  for (const record of page.records) {
    if (record.event.type !== 'assistant/message') continue
    const data = record.event.data
    if (typeof data !== 'object' || data === null || !('message' in data)) continue
    const message = (data as { message?: { content?: unknown } }).message
    const content = message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
          .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block !== null && 'text' in (block as object))
          .map(block => block.text ?? '').join('')
        : ''
    if (text.length > 0) {
      console.log('ASSISTANT:', text.slice(0, 500))
      if (text.includes('RESULT:')) sawAnswer = true
    }
  }
  void throughSeq
  const types = [...new Set(page.records.map(r => String(r.event.type)))]
  if (types.length > 0) console.log('EVENTS:', types.join(','))
  const state = await rpc<{ state?: string; status?: string }>('session/state', { request: { sessionId: created.sessionId } }).catch((error: unknown) => { console.log('state err:', String(error).slice(0, 120)); return {} })
  if (Object.keys(state).length > 0) console.log('STATE:', JSON.stringify(state).slice(0, 200))
  if (sawAnswer) break
}
console.log(sawAnswer ? 'LIVE-PASS' : 'LIVE-TIMEOUT')
