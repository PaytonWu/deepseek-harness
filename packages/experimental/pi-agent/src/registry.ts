/**
 * Durable pointer registry for pi children: one record per child mapping the
 * model-facing id to the pi session file, run state, and working directory.
 * Stored under the Harness home so backup, cleanup, and uninstall follow it.
 * @module pi-registry
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const execFileAsync = promisify(execFile)

/** One durable child record. */
export interface PiChildRecord {
  /** Model-facing child id. */
  readonly id: string
  /** pi session file backing this child. */
  readonly sessionFile: string
  /** pi session id, when pi reported one. */
  readonly sessionId?: string
  /** Working directory the child runs in. */
  readonly cwd: string
  /** `'running'` while a live process is assumed, `'inactive'` otherwise. */
  state: 'running' | 'inactive'
  /** Process id of the live child, while assumed running. */
  pid?: number
  /** Creation time, ISO timestamp. */
  readonly createdAt: string
  /** Bounded last answer text, when one was observed. */
  lastResult?: string
}

/** Where the registry file and pi sessions live under the Harness home. */
export function piAgentPaths(): { readonly root: string; readonly sessions: string; readonly registryFile: string } {
  const root = dshHomePath('pi-agent')
  return { root, sessions: join(root, 'sessions'), registryFile: join(root, 'children.json') }
}

/** Load and persist child records; sweep assumed-running leftovers from a crashed Host. */
export class PiChildRegistry {
  private readonly records = new Map<string, PiChildRecord>()

  private constructor(private readonly file: string, private readonly sessionsDir: string) {}

  /** Load the registry; a missing file starts empty, a malformed file fails loudly. */
  static load(paths: { file: string; sessionsDir: string }): PiChildRegistry {
    const registry = new PiChildRegistry(paths.file, paths.sessionsDir)
    if (!existsSync(paths.file)) return registry
    const parsed: unknown = JSON.parse(readFileSync(paths.file, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error(`pi-agent: registry file ${paths.file} is malformed (expected an array)`)
    for (const entry of parsed) {
      const record = entry as PiChildRecord
      if (typeof record.id !== 'string' || typeof record.sessionFile !== 'string' || typeof record.cwd !== 'string') {
        throw new Error(`pi-agent: registry file ${paths.file} is malformed (a child record misses required fields)`)
      }
      registry.records.set(record.id, record)
    }
    return registry
  }

  /** All records in creation order. */
  list(): readonly PiChildRecord[] { return [...this.records.values()] }

  /** One record by id. */
  get(id: string): PiChildRecord | undefined { return this.records.get(id) }

  /** Create and persist one running record. */
  async create(input: { sessionFile: string; sessionId?: string; cwd: string; pid?: number }): Promise<PiChildRecord> {
    const record: PiChildRecord = {
      id: randomUUID().slice(0, 8),
      sessionFile: input.sessionFile,
      ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
      cwd: input.cwd,
      state: 'running',
      ...input.pid !== undefined ? { pid: input.pid } : {},
      createdAt: new Date().toISOString(),
    }
    this.records.set(record.id, record)
    await this.save()
    return record
  }

  /** Patch and persist one record. */
  async update(id: string, patch: Partial<Pick<PiChildRecord, 'state' | 'pid' | 'sessionId' | 'lastResult'>>): Promise<PiChildRecord> {
    const record = this.records.get(id)
    if (record === undefined) throw new Error(`pi-agent: unknown child ${id}`)
    const next: PiChildRecord = { ...record, ...patch }
    this.records.set(id, next)
    await this.save()
    return next
  }

  private async save(): Promise<void> {
    const entries = [...this.records.values()].map((record): PiChildRecord => {
      const clean: PiChildRecord = { ...record }
      if (clean.state === 'inactive') delete clean.pid
      return clean
    })
    await writeFileAtomic(this.file, `${JSON.stringify(entries, undefined, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * Kill processes left over from a crashed Host. A pid is killed only when
   * its command line still names this registry's pi sessions directory;
   * uncertain checks are skipped with a warning.
   * @param warn - Receives one line per skipped or killed leftover.
   * @returns Number of verified leftovers killed.
   */
  async sweepOrphans(warn: (line: string) => void): Promise<number> {
    let killed = 0
    for (const record of this.records.values()) {
      if (record.state !== 'running' || record.pid === undefined) continue
      const commandLine = await commandLineOf(record.pid)
      if (commandLine === undefined) {
        warn(`pi-agent: leftover child ${record.id} (pid ${String(record.pid)}) has an unverifiable command line; skipped`)
      } else if (commandLine.includes(this.sessionsDir) || isPiRpcCommand(commandLine)) {
        if (killProcess(record.pid)) {
          killed += 1
          warn(`pi-agent: killed leftover child ${record.id} (pid ${String(record.pid)})`)
        } else {
          warn(`pi-agent: leftover child ${record.id} (pid ${String(record.pid)}) could not be terminated; skipped`)
        }
      }
      await this.update(record.id, { state: 'inactive' })
    }
    return killed
  }
}

function isPiRpcCommand(commandLine: string): boolean {
  return /(^|[/\\])pi(\.cmd|\.exe)?(["\s]|$)/iu.test(commandLine) && commandLine.includes('--mode') && commandLine.includes('rpc')
}

async function commandLineOf(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`], { timeout: 5_000 })
      const line = stdout.trim()
      return line === '' ? undefined : line
    }
    if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('cat', [`/proc/${String(pid)}/cmdline`], { timeout: 5_000 })
      return stdout.replaceAll('\0', ' ').trim()
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5_000 })
      const line = stdout.trim()
      return line === '' ? undefined : line
    }
    return undefined
  } catch {
    return undefined
  }
}

function killProcess(pid: number): boolean {
  try {
    process.kill(pid, process.platform === 'win32' ? undefined : 'SIGTERM')
    return true
  } catch {
    return false
  }
}

/** Create the plugin's directories under the Harness home. */
export async function ensurePiAgentDirs(): Promise<{ root: string; sessions: string; registryFile: string }> {
  const paths = piAgentPaths()
  await mkdir(paths.sessions, { recursive: true })
  return paths
}
