/**
 * The v1 DingTalk transport: a dws-backed `DingtalkTransport`. Sending runs
 * `dws chat +send-to-group` into the user's notification group (messages
 * therefore originate from the user's own account and are prefixed 【 by the
 * pipeline); receiving supervises a `dws event +listen-im` long-connection
 * child process that emits NDJSON events, restarting it whenever it dies.
 * @module pi-admin-dws-transport
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** One inbound IM instruction from the user's account. */
export interface InboundDingtalkMessage {
  /** Sender identity (openDingTalkId) for whitelist checks. */
  readonly senderId: string
  /** Message text. */
  readonly content: string
}

/** Dependency seam: spawn for tests. */
export type DwsSpawn = (command: string, args: string[]) => ChildProcess

/** Transport configuration. */
export interface DwsTransportOptions {
  /** The notification group's openConversationId. */
  readonly notificationGroupId: string
  /** Whitelisted senders (openDingTalkIds); an empty/omitted list accepts none. */
  readonly allowedSenderOpenDingTalkIds?: readonly string[]
  /** Delay before restarting a dead listener; tests pass 0. */
  readonly restartDelayMs?: number
  /** Spawn seam; tests stub it. */
  readonly spawn?: DwsSpawn
}

/**
 * The dws implementation of the DingTalk channel: send spawns `dws chat
 * +send-to-group` (always `--yes`, the CLI requires it non-interactively);
 * receive supervises the `dws event +listen-im` child and parses its NDJSON
 * event lines, restarting the child whenever it exits.
 */
export class DwsTransport {
  private readonly spawnFn: DwsSpawn
  private readonly restartDelayMs: number
  private listener: ChildProcess | undefined = undefined
  private stopped = false
  private readonly receiveCallbacks: Array<(message: InboundDingtalkMessage) => void> = []

  constructor(private readonly options: DwsTransportOptions) {
    this.spawnFn = options.spawn ?? ((command, args) => spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }))
    this.restartDelayMs = options.restartDelayMs ?? 2_000
  }

  /** Send one message into the notification group; rejects on dws failure. */
  async send(message: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnFn('dws', [
        'chat', '+send-to-group', '--group', this.options.notificationGroupId,
        '--content', message, '--yes', '--format', 'json',
      ])
      let output = ''
      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
          return
        }
        reject(new Error(`pi-agent: dws send exited with ${String(code)}: ${output.slice(0, 300)}`))
      })
    })
  }

  /** Start the supervised listener; multiple callbacks all receive events. */
  start(receive: (message: InboundDingtalkMessage) => void): Promise<void> {
    this.receiveCallbacks.push(receive)
    this.stopped = false
    if (this.listener === undefined) this.spawnListener()
    return Promise.resolve()
  }

  /** Stop the listener; it stays stopped until {@link start} runs again. */
  stop(): Promise<void> {
    this.stopped = true
    this.listener?.kill()
    this.listener = undefined
    return Promise.resolve()
  }

  /** Spawn one `dws event +listen-im` child wired to the NDJSON parser. */
  private spawnListener(): void {
    const child = this.spawnFn('dws', [
      'event', '+listen-im', '--kind', 'group',
      '--chat-id', this.options.notificationGroupId, '--format', 'json',
    ])
    this.listener = child
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        this.dispatchLine(line)
        newline = buffer.indexOf('\n')
      }
    })
    child.on('close', () => {
      this.listener = undefined
      if (this.stopped) return
      setTimeout(() => {
        if (!this.stopped && this.listener === undefined) this.spawnListener()
      }, this.restartDelayMs)
    })
  }

  /** Parse one NDJSON line; drop ready markers, other groups, non-whitelisted senders, and pipeline echoes. */
  private dispatchLine(line: string): void {
    if (line === '' || !line.startsWith('{')) return
    let parsed: { conversation_id?: string; sender_open_dingtalk_id?: string; content?: string }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      return
    }
    const groupId = this.options.notificationGroupId
    const senderId = parsed.sender_open_dingtalk_id
    const content = parsed.content
    if (parsed.conversation_id !== groupId || senderId === undefined || content === undefined) return
    if (!this.options.allowedSenderOpenDingTalkIds?.includes(senderId)) return
    // Pipeline sends are 【-prefixed (loop prevention): they must never come
    // back as instructions.
    if (content.startsWith('【')) return
    for (const callback of this.receiveCallbacks) callback({ senderId, content })
  }
}
