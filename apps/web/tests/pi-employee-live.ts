/**
 * One-shot live driver for the digital-employee flow against the running
 * `dsh web` Host: create an employee through the directory API, send one
 * prompt into its bound session, and poll the session page until the pi
 * answer arrives. Usage:
 *   node --import tsx/esm apps/web/tests/pi-employee-live.ts <http-url-with-token>
 * @module pi-employee-live
 */

import { randomUUID } from 'node:crypto'

const launchUrl = process.argv[2]
if (launchUrl === undefined) {
  console.error('usage: pi-employee-live.ts <http://127.0.0.1:3080/?token=...>')
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

const existing = await rpc<{ id: string }[]>('employee/list', {})
for (const stale of existing) await rpc('employee/delete', { request: { id: stale.id } }).catch(() => undefined)

const created = await rpc<{ id: string; name: string; sessionId: string }>('employee/create', { request: {
  name: '数字程序员',
  description: '你是数字程序员，负责编码任务。收到消息后按要求完成任务并简要汇报。',
  cwd: 'D:/Documents/github/deepseek/deepseek-harness',
} })
console.log('EMPLOYEE-CREATED:', JSON.stringify(created))

await rpc<{ accepted: true }>('session/prompt', { request: {
  requestId: randomUUID(),
  sessionId: created.sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: 'Reply with exactly: EMPLOYEE-OK' }],
} })
console.log('prompt accepted; polling for the pi answer...')

interface PageRecord { type: string; data: unknown }
const deadline = Date.now() + 300_000
let sawAnswer = false
while (Date.now() < deadline) {
  await new Promise((resolve) => { setTimeout(resolve, 4_000) })
  const page = await rpc<{ records: PageRecord[] }>('session/page', {
    request: { address: { kind: 'session', sessionId: created.sessionId }, throughSeq: 0, maxMessages: 50 },
  })
  for (const record of page.records) {
    if (record.type !== 'assistant/message') continue
    const data = record.data
    if (typeof data !== 'object' || data === null || !('message' in data)) continue
    const message = (data as { message?: { content?: unknown } }).message
    const content = message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content as Array<{ text?: string }>).map(block => block.text ?? '').join('')
        : ''
    if (text.length > 0) {
      console.log('ASSISTANT:', text.slice(0, 300))
      if (text.includes('EMPLOYEE-OK')) sawAnswer = true
    }
  }
  if (sawAnswer) break
}
console.log(sawAnswer ? 'EMPLOYEE-LIVE-PASS' : 'EMPLOYEE-LIVE-TIMEOUT')
