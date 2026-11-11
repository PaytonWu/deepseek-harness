/**
 * Live child-process bookkeeping shared by the anonymous `pi_agent` tool and
 * the digital-employee adapter. Anonymous children persist into the pointer
 * registry; employee children hang off their employee records alone.
 * @module pi-manager
 */

import { PiRpcChild } from './rpc.ts'
import type { PiChildRegistry } from './registry.ts'
import type { EmployeeRecord } from './employee-store.ts'

/** Fixed spawn inputs shared by every child of one plugin instance. */
export interface SpawnInputs {
  command: string
  args: readonly string[]
  sessionDir: string
  tools?: string
  provider?: string
  model?: string
  env: Readonly<Record<string, string>>
}

/** Live child processes keyed by their owning id (anonymous childId or employee id). */
export class PiChildManager {
  private readonly children = new Map<string, PiRpcChild>()

  constructor(private readonly registry: PiChildRegistry, private readonly spawnOptions: SpawnInputs) {}

  /** Live children that have not exited. */
  liveCount(): number {
    let count = 0
    for (const child of this.children.values()) if (!child.hasExited) count += 1
    return count
  }

  /** The live child for one id, or undefined when absent or exited. */
  live(id: string): PiRpcChild | undefined {
    const child = this.children.get(id)
    return child === undefined || child.hasExited ? undefined : child
  }

  /** Start a new anonymous child, persist its record, and deliver the first task. */
  async create(cwd: string, task: string): Promise<{ id: string }> {
    const child = PiRpcChild.start({ ...this.spawnOptions, cwd })
    const ready = await child.ready()
    if (ready.sessionFile === undefined) throw new Error('pi-agent: the pi child did not report a session file')
    const record = await this.registry.create({
      sessionFile: ready.sessionFile,
      ...ready.sessionId !== undefined ? { sessionId: ready.sessionId } : {},
      cwd,
      ...child.pid !== undefined ? { pid: child.pid } : {},
    })
    this.children.set(record.id, child)
    this.watchExit(record.id, child)
    await child.sendPrompt(task)
    this.observeSettled(record.id, child)
    return { id: record.id }
  }

  /** Cold-resume one recorded anonymous child from its pi session file. */
  async attach(id: string, sessionFile: string, cwd: string): Promise<PiRpcChild> {
    const child = PiRpcChild.start({ ...this.spawnOptions, cwd, sessionFile })
    this.children.set(id, child)
    this.watchExit(id, child)
    await this.registry.update(id, { state: 'running', ...child.pid !== undefined ? { pid: child.pid } : {} })
    return child
  }

  /**
   * Ensure the employee's pi child is live: reuse it, cold-resume the bound
   * session file, or start a fresh one. Employee children never touch the
   * anonymous pointer registry.
   * @returns the live child and whether this call created a fresh pi session.
   */
  async ensureForEmployee(employee: EmployeeRecord): Promise<{ child: PiRpcChild; createdFresh: boolean }> {
    const existing = this.live(employee.id)
    if (existing !== undefined) return { child: existing, createdFresh: false }
    const createdFresh = employee.piSessionFile === undefined
    const child = PiRpcChild.start({
      ...this.spawnOptions,
      cwd: employee.cwd,
      ...!createdFresh ? { sessionFile: employee.piSessionFile } : {},
    })
    this.children.set(employee.id, child)
    this.watchExit(employee.id, child)
    await child.ready()
    return { child, createdFresh }
  }

  /** Record the bounded last answer once the current run settles. */
  observeSettled(id: string, child: PiRpcChild): void {
    void (async () => {
      try {
        await child.waitSettled()
        const text = await child.lastAssistantText()
        await this.registry.update(id, { lastResult: text ?? '' })
      } catch {
        // an unreadable settled answer stays absent; later status calls retry
      }
    })()
  }

  /** Terminate every live child; used on plugin unload and Host exit. */
  async disposeAll(): Promise<void> {
    const exits: Array<Promise<void>> = []
    for (const child of this.children.values()) {
      if (!child.hasExited) exits.push(child.dispose())
    }
    await Promise.allSettled(exits)
    this.children.clear()
  }

  private watchExit(id: string, child: PiRpcChild): void {
    void child.waitExit().then(() => {
      // employee ids own no anonymous registry record; their lifecycle lives on the employee
      if (this.registry.get(id) === undefined) return
      void this.registry.update(id, { state: 'inactive' }).catch(() => undefined)
    })
  }
}
