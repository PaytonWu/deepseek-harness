/**
 * Durable employee directory: one record per user-created digital employee
 * (name, description, working directory, optional imported pi session file,
 * and the bound dsh session id). Stored beside the child registry under the
 * Harness home so backup, cleanup, and uninstall follow it.
 * @module pi-employee-store
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** One durable digital-employee record. */
export interface EmployeeRecord {
  /** Employee id, also the adapter route suffix. */
  readonly id: string
  /** User-visible name; unique within the directory. */
  name: string
  /** Responsibility description injected into a fresh pi session. */
  description: string
  /** Working directory the employee's pi child runs in. */
  cwd: string
  /** Imported pi session file; omitted until the first conversation creates one. */
  piSessionFile?: string
  /** Bound dsh session id; set when the employee's session is first opened. */
  sessionId?: string
  /** Creation time, ISO timestamp. */
  readonly createdAt: string
}

/** Input for one employee creation. */
export interface EmployeeCreateInput {
  readonly name: string
  readonly description: string
  readonly cwd: string
  readonly piSessionFile?: string
}

/** Patchable fields of one employee record. */
export type EmployeePatch = Partial<Pick<EmployeeRecord, 'name' | 'description' | 'cwd' | 'piSessionFile' | 'sessionId'>>

/** Load and persist the employee directory; malformed files fail loudly. */
export class EmployeeStore {
  private readonly records = new Map<string, EmployeeRecord>()

  private constructor(private readonly file: string) {}

  /** Load the directory; a missing file starts empty, a malformed file fails loudly. */
  static load(file: string): EmployeeStore {
    const store = new EmployeeStore(file)
    if (!existsSync(file)) return store
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error(`pi-agent: employee directory ${file} is malformed (expected an array)`)
    for (const entry of parsed) {
      const record = entry as EmployeeRecord
      if (typeof record.id !== 'string' || typeof record.name !== 'string'
        || typeof record.description !== 'string' || typeof record.cwd !== 'string') {
        throw new Error(`pi-agent: employee directory ${file} is malformed (an employee record misses required fields)`)
      }
      store.records.set(record.id, record)
    }
    return store
  }

  /** All records in creation order. */
  list(): readonly EmployeeRecord[] { return [...this.records.values()] }

  /** One record by id. */
  get(id: string): EmployeeRecord | undefined { return this.records.get(id) }

  /** Resolve one record by its bound dsh session id. */
  bySession(sessionId: string): EmployeeRecord | undefined {
    return this.list().find(employee => employee.sessionId === sessionId)
  }

  /** Validate input and persist one new employee. */
  async create(input: EmployeeCreateInput): Promise<EmployeeRecord> {
    if (input.name.trim().length === 0) throw new Error('pi-agent: employee name must be a non-empty string')
    if (input.description.trim().length === 0) throw new Error('pi-agent: employee description must be a non-empty string')
    if (!isDirectory(input.cwd)) throw new Error(`pi-agent: employee cwd is not an existing directory: ${input.cwd}`)
    if (input.piSessionFile !== undefined && !existsSync(input.piSessionFile)) {
      throw new Error(`pi-agent: imported pi session file does not exist: ${input.piSessionFile}`)
    }
    if (this.list().some(employee => employee.name === input.name)) {
      throw new Error(`pi-agent: an employee named "${input.name}" already exists`)
    }
    const record: EmployeeRecord = {
      id: randomUUID().slice(0, 8),
      name: input.name,
      description: input.description,
      cwd: input.cwd,
      ...input.piSessionFile !== undefined ? { piSessionFile: input.piSessionFile } : {},
      createdAt: new Date().toISOString(),
    }
    this.records.set(record.id, record)
    await this.save()
    return record
  }

  /** Patch and persist one employee. */
  async update(id: string, patch: EmployeePatch): Promise<EmployeeRecord> {
    const current = this.records.get(id)
    if (current === undefined) throw new Error(`pi-agent: unknown employee ${id}`)
    if (patch.cwd !== undefined && !isDirectory(patch.cwd)) {
      throw new Error(`pi-agent: employee cwd is not an existing directory: ${patch.cwd}`)
    }
    if (patch.name !== undefined && this.list().some(employee => employee.id !== id && employee.name === patch.name)) {
      throw new Error(`pi-agent: an employee named "${patch.name}" already exists`)
    }
    if (patch.piSessionFile !== undefined && !existsSync(patch.piSessionFile)) {
      throw new Error(`pi-agent: imported pi session file does not exist: ${patch.piSessionFile}`)
    }
    const next: EmployeeRecord = { ...current, ...patch }
    this.records.set(id, next)
    await this.save()
    return next
  }

  /**
   * Record the pi session file our own child just reported. Unlike an import,
   * the file is authoritative from the child's `get_state`, so no existence
   * check races the child's own flush.
   */
  async bindSessionFile(id: string, piSessionFile: string): Promise<void> {
    const current = this.records.get(id)
    if (current === undefined) throw new Error(`pi-agent: unknown employee ${id}`)
    if (current.piSessionFile === piSessionFile) return
    this.records.set(id, { ...current, piSessionFile })
    await this.save()
  }

  /** Remove and persist one employee. */
  async delete(id: string): Promise<void> {
    if (!this.records.has(id)) throw new Error(`pi-agent: unknown employee ${id}`)
    this.records.delete(id)
    await this.save()
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify([...this.records.values()], undefined, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
