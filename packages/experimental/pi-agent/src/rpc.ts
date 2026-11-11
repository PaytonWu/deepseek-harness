/**
 * One pi coding-agent child in RPC mode. Owns the spawned process, JSONL
 * command/response correlation, and run-state observation; the wire contract
 * is documented with the installed pi package.
 * @module pi-rpc
 */

import { spawn } from 'cross-spawn'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'

/** Graceful-termination wait before forceful kill, milliseconds. */
const DISPOSE_GRACE_MS = 3_000
/** Bounded wait for `abort` to settle the child, milliseconds. */
const ABORT_WAIT_MS = 60_000
/** Bounded wait for one command response, milliseconds. */
const COMMAND_TIMEOUT_MS = 120_000
/** Bounded characters kept from one pi answer. */
export const MAX_RESULT_CHARS = 16_384

/** pi is not resolvable from the Host process environment. */
export class PiMissingError extends Error {
  constructor(command: string, cause: Error) {
    super(`pi-agent: "${command}" could not be started (${cause.message}). Install pi so it is resolvable from the Host PATH; this plugin neither downloads nor bundles a pi runtime.`, { cause })
    this.name = 'PiMissingError'
  }
}

/** The child process exited before an outstanding command answered. */
export class PiExitedError extends Error {
  constructor(detail: string) {
    super(`pi-agent: the pi child exited before answering (${detail})`)
    this.name = 'PiExitedError'
  }
}

/** Spawn options for one pi child. */
export interface PiSpawnOptions {
  /** Executable to start. */
  readonly command: string
  /** Arguments inserted before this module's own mode arguments. */
  readonly args: readonly string[]
  /** Child working directory. */
  readonly cwd: string
  /** Directory pi persists session files under. */
  readonly sessionDir: string
  /** Existing session file to resume, or undefined for a fresh session. */
  readonly sessionFile?: string
  /** pi tool selection forwarded to `--tools`. */
  readonly tools?: string
  /** Provider name forwarded to `--provider`. */
  readonly provider?: string
  /** Model id forwarded to `--model`. */
  readonly model?: string
  /** Environment layered over the parent environment. */
  readonly env: Readonly<Record<string, string>>
}

/** RPC `get_state` answer fields this plugin consumes. */
export interface PiState {
  readonly isStreaming: boolean
  readonly sessionId?: string
  readonly sessionFile?: string
  readonly messageCount?: number
}

type RecordKind = 'response' | 'session-event' | 'other'

interface RpcRecord {
  readonly type?: string
  readonly id?: string
  readonly command?: string
  readonly success?: boolean
  readonly data?: unknown
  readonly error?: { message?: string }
}

/** Split one stdout stream into LF-terminated records without recognizing Unicode line separators. */
export class LineReader {
  private buffer = ''
  private readonly decoder = new TextDecoder('utf-8')

  /** Feed one chunk; @returns complete LF-terminated lines. */
  push(chunk: Buffer): readonly string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    const lines: string[] = []
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') lines.push(line)
      index = this.buffer.indexOf('\n')
    }
    return lines
  }

  /** Flush a trailing record without terminator, if any. */
  flush(): readonly string[] {
    const rest = this.buffer + this.decoder.decode()
    this.buffer = ''
    return rest === '' ? [] : [rest]
  }
}

function classify(record: RpcRecord): RecordKind {
  if (record.type === 'response' && typeof record.command === 'string') return 'response'
  if (typeof record.type === 'string' && record.type !== 'response') return 'session-event'
  return 'other'
}

/** One live pi child process speaking the pi RPC protocol. */
export class PiRpcChild {
  private readonly process: ChildProcess
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>()
  private readonly lineReader = new LineReader()
  private readonly settleWaiters: Array<() => void> = []
  private readonly exitWaiters: Array<() => void> = []
  private stderrTail = ''
  private exited = false
  private exitDetail = 'unknown exit'
  private fatalError: Error | undefined
  private runsStarted = 0
  private runsSettled = 0
  private optimisticStart = false
  private _sessionFile: string | undefined
  private _sessionId: string | undefined
  private disposed = false

  private constructor(process: ChildProcess, command: string) {
    this.process = process
    process.stdout?.on('data', (chunk: Buffer) => { this.consume(chunk) })
    process.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2_000)
    })
    process.on('error', (error: NodeJS.ErrnoException) => {
      const translated = error.code === 'ENOENT' ? new PiMissingError(command, error) : error
      this.fatalError = translated
      this.failPending(translated)
      this.markExited(error.message)
    })
    process.on('exit', (code, signal) => { this.failPending(new PiExitedError(this.exitDetail)); this.markExited(`exit ${String(code ?? signal ?? '?')}`) })
  }

  /** Spawn one pi child; pending commands reject with {@link PiMissingError} when the executable is absent. */
  static start(options: PiSpawnOptions): PiRpcChild {
    const argv = [
      ...options.args,
      '--mode', 'rpc',
      '--session-dir', options.sessionDir,
      ...options.sessionFile !== undefined ? ['--session', options.sessionFile] : [],
      ...options.tools !== undefined ? ['--tools', options.tools] : [],
      ...options.provider !== undefined ? ['--provider', options.provider] : [],
      ...options.model !== undefined ? ['--model', options.model] : [],
    ]
    return new PiRpcChild(spawn(options.command, argv, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }), options.command)
  }

  /** The concrete session file pi reported, once known. */
  get sessionFile(): string | undefined { return this._sessionFile }
  /** The session id pi reported, once known. */
  get sessionId(): string | undefined { return this._sessionId }
  /** Host-side process id of the spawned child, or undefined after exit. */
  get pid(): number | undefined { return this.process.pid }
  /** Whether a run is currently streaming. */
  get isStreaming(): boolean { return this.runsStarted > this.runsSettled }
  /** Whether the process has exited. */
  get hasExited(): boolean { return this.exited }

  /** Complete the RPC handshake; resolves with the child's session state. */
  async ready(): Promise<PiState> {
    const state = await this.command<PiState>('get_state')
    this._sessionFile = state.sessionFile
    this._sessionId = state.sessionId
    this.calibrate(state.isStreaming)
    return state
  }

  /** Send one user message; a streaming child queues it as a follow-up. */
  async sendPrompt(text: string): Promise<string> {
    const data = await this.command<{ disposition?: string }>('prompt', {
      message: text,
      ...this.isStreaming ? { streamingBehavior: 'followUp' as const } : {},
    })
    if (data.disposition === 'started' && !this.isStreaming && !this.optimisticStart) {
      // the run's agent_start event may still be in flight; count it optimistically
      this.optimisticStart = true
      this.runsStarted += 1
    }
    return data.disposition ?? 'accepted'
  }

  /** Drop queued messages and abort the current run; bounds the idle wait. */
  async interrupt(): Promise<void> {
    await this.command('clear_queue')
    const bounded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('pi-agent: abort did not settle within the bounded wait')) }, ABORT_WAIT_MS)
      timer.unref()
      void this.command('abort').then(() => { clearTimeout(timer); resolve() }, (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) })
    })
    await bounded
    // abort responds once the session is idle, so align the run counters
    this.calibrate(false)
  }

  /** Current session state from the child. */
  async state(): Promise<PiState> {
    const state = await this.command<PiState>('get_state')
    this.calibrate(state.isStreaming)
    return state
  }

  /** Align run counters with one authoritative streaming answer. */
  private calibrate(streaming: boolean): void {
    this.optimisticStart = false
    this.runsStarted = streaming ? 1 : 0
    this.runsSettled = 0
  }

  /** Last assistant text, bounded; `undefined` before any answer. */
  async lastAssistantText(): Promise<string | undefined> {
    const data = await this.command<{ text?: string | null }>('get_last_assistant_text')
    const text = data.text === null ? undefined : data.text
    return text === undefined ? undefined : text.slice(0, MAX_RESULT_CHARS)
  }

  /** Settle-poll interval while waiting on events; the authoritative state query self-heals a lost event. */
  private static readonly SETTLE_POLL_MS = 2_000

  /** Resolve when the current run settles, or immediately when idle or exited. */
  async waitSettled(): Promise<void> {
    while (!this.exited && this.isStreaming) {
      await Promise.race([
        new Promise<void>((resolve) => { this.settleWaiters.push(resolve) }),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, PiRpcChild.SETTLE_POLL_MS)
          timer.unref()
        }),
      ])
      // an authoritative poll calibrates the run counters when a settle event never arrived;
      // the while condition re-reads the calibrated streaming state
      try {
        await this.state()
      } catch {
        break
      }
    }
  }

  /** Resolve once the process exits, however it exits. */
  async waitExit(): Promise<void> {
    if (this.exited) return
    await new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve)
    })
  }

  /** Terminate the child: graceful request, then forceful kill after the grace bound. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const exit = this.waitExit()
    const kill = () => { this.process.kill('SIGKILL') }
    const timer = setTimeout(kill, DISPOSE_GRACE_MS)
    timer.unref()
    try {
      this.process.kill('SIGTERM')
    } catch {
      // already gone; waitExit resolves through the exit handler
    }
    await exit
    clearTimeout(timer)
  }

  private command<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.exited) {
        reject(this.fatalError ?? new PiExitedError(this.exitDetail))
        return
      }
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`pi-agent: RPC "${type}" received no response within ${String(COMMAND_TIMEOUT_MS)}ms`))
      }, COMMAND_TIMEOUT_MS)
      timer.unref()
      const settle = (): void => { clearTimeout(timer) }
      this.pending.set(id, {
        resolve: (data) => { settle(); resolve(data as T) },
        reject: (error) => { settle(); reject(error) },
      })
      this.process.stdin?.write(`${JSON.stringify({ id, type, ...payload })}\n`, (error) => {
        if (error !== undefined && error !== null) {
          this.pending.delete(id)
          settle()
          reject(new PiExitedError(this.exitDetail))
        }
      })
    })
  }

  private consume(chunk: Buffer): void {
    for (const line of this.lineReader.push(chunk)) {
      let record: RpcRecord
      try {
        record = JSON.parse(line) as RpcRecord
      } catch {
        continue
      }
      this.dispatch(record)
    }
  }

  private dispatch(record: RpcRecord): void {
    const kind = classify(record)
    if (kind === 'response') {
      if (typeof record.id !== 'string') return
      const waiter = this.pending.get(record.id)
      if (waiter === undefined) return
      this.pending.delete(record.id)
      if (record.success === true) waiter.resolve(record.data ?? {})
      else waiter.reject(new Error(`pi RPC ${String(record.command)} failed: ${record.error?.message ?? 'unknown error'}`))
      return
    }
    if (kind === 'session-event') {
      if (record.type === 'agent_start') {
        if (this.optimisticStart) this.optimisticStart = false
        else this.runsStarted += 1
      } else if (record.type === 'agent_settled') {
        if (this.runsSettled < this.runsStarted) this.runsSettled += 1
        const waiters = this.settleWaiters.splice(0)
        for (const waiter of waiters) waiter()
      }
    }
  }

  private failPending(error: Error): void {
    const waiters = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of waiters) waiter.reject(error)
  }

  private markExited(detail: string): void {
    if (this.exited) return
    this.exitDetail = detail
    this.exited = true
    this.runsSettled = this.runsStarted
    for (const line of this.lineReader.flush()) {
      try {
        this.dispatch(JSON.parse(line) as RpcRecord)
      } catch {
        // an incomplete trailing record at exit stays unreadable by design
      }
    }
    const settleWaiters = this.settleWaiters.splice(0)
    for (const waiter of settleWaiters) waiter()
    const exitWaiters = this.exitWaiters.splice(0)
    for (const waiter of exitWaiters) waiter()
  }
}
