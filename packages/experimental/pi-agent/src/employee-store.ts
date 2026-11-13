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

/** Employee type ids and their presets. */
export const EMPLOYEE_TYPES = {
  'pi-coder': {
    label: '数字程序员',
    description: '你是数字程序员，负责编码任务。收到消息后按要求完成任务并简要汇报。',
    emoji: '🧑‍💻',
  },
  'admin': {
    label: '数字管理员',
    description: '你是数字管理员，负责管理用户的数字程序员团队：分派任务、跟踪进度、汇总反馈。收到消息后调用可用工具完成任务并简要汇报。',
    emoji: '🧑‍💼',
  },
} as const

/** Employee type id. */
export type EmployeeTypeId = keyof typeof EMPLOYEE_TYPES

/** IM channel of a management-layer employee; the transport implementation is selected by it. */
export type EmployeeChannel = 'dingtalk'

/** One selectable pi model for an employee. */
export interface EmployeePiModel {
  readonly provider: string
  readonly modelId: string
}

/** One durable digital-employee record. */
export interface EmployeeRecord {
  /** Employee id, also the adapter route suffix. */
  readonly id: string
  /** Employee type; selects the preset template. */
  readonly type: EmployeeTypeId
  /** User-visible name; unique within the directory. */
  name: string
  /** Emoji avatar badge. */
  avatar: string
  /** Responsibility description injected into a fresh pi session. */
  description: string
  /** Working directory the employee's pi child runs in. */
  cwd: string
  /** IM channel; admins only (a first-line employee is never channeled). */
  channel?: EmployeeChannel
  /** The admin managing this employee; first-line employees only. */
  managerId?: string
  /** Pi model override for this employee's children. */
  piModel?: EmployeePiModel
  /** Thinking level applied once when a child starts: off/low/medium/high; omitted follows pi. */
  thinking?: 'off' | 'low' | 'medium' | 'high'
  /** Imported pi session file; omitted until the first conversation creates one. */
  piSessionFile?: string
  /** Bound dsh session id; set when the employee's session is first opened. */
  sessionId?: string
  /** Creation time, ISO timestamp. */
  readonly createdAt: string
}

/** Input for one employee creation. */
export interface EmployeeCreateInput {
  readonly type?: EmployeeTypeId
  readonly name?: string
  readonly avatar?: string
  readonly description?: string
  /** Working directory; the admin orchestration supplies the group directory. */
  readonly cwd?: string
  /** IM channel; required for an admin, rejected on any other type. */
  readonly channel?: EmployeeChannel
  /** Admin to bind; omitted resolves to the sole admin, ambiguous with many. */
  readonly managerId?: string
  readonly piModel?: EmployeePiModel
  readonly thinking?: 'off' | 'low' | 'medium' | 'high'
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
      const record = entry as Partial<EmployeeRecord> & { id?: unknown }
      if (typeof record.id !== 'string' || typeof record.name !== 'string'
        || typeof record.description !== 'string' || typeof record.cwd !== 'string') {
        throw new Error(`pi-agent: employee directory ${file} is malformed (an employee record misses required fields)`)
      }
      // records written before type/avatar carry no field; fill the pi-coder preset
      store.records.set(record.id, {
        ...record,
        type: 'pi-coder',
        avatar: record.avatar ?? EMPLOYEE_TYPES['pi-coder'].emoji,
      } as EmployeeRecord)
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
    const type = input.type ?? 'pi-coder'
    const preset = EMPLOYEE_TYPES[type]
    const name = input.name === undefined || input.name.trim().length === 0 ? this.defaultName(type) : input.name.trim()
    const description = input.description === undefined || input.description.trim().length === 0 ? preset.description : input.description
    // Channel is the admin's IM dimension: required there, meaningless (and
    // therefore rejected) on any other type.
    const channel = this.resolveChannel(type, input.channel)
    const managerId = this.resolveManagerId(type, input.managerId)
    if (input.cwd === undefined || !isDirectory(input.cwd)) {
      throw new Error(`pi-agent: employee cwd is not an existing directory: ${String(input.cwd)}`)
    }
    if (input.piSessionFile !== undefined && !existsSync(input.piSessionFile)) {
      throw new Error(`pi-agent: imported pi session file does not exist: ${input.piSessionFile}`)
    }
    if (this.list().some(employee => employee.name === name)) {
      throw new Error(`pi-agent: an employee named "${name}" already exists`)
    }
    const record: EmployeeRecord = {
      id: randomUUID().slice(0, 8),
      type,
      name,
      avatar: input.avatar === undefined || input.avatar.trim().length === 0 ? preset.emoji : input.avatar,
      description,
      cwd: input.cwd,
      ...channel !== undefined ? { channel } : {},
      ...managerId !== undefined ? { managerId } : {},
      ...input.piModel !== undefined ? { piModel: input.piModel } : {},
      ...input.thinking !== undefined ? { thinking: input.thinking } : {},
      ...input.piSessionFile !== undefined ? { piSessionFile: input.piSessionFile } : {},
      createdAt: new Date().toISOString(),
    }
    this.records.set(record.id, record)
    await this.save()
    return record
  }

  /** Validate the channel against the employee type; admins require one. */
  private resolveChannel(type: EmployeeTypeId, channel: EmployeeChannel | undefined): EmployeeChannel | undefined {
    if (type === 'admin') {
      if (channel === undefined) throw new Error('pi-agent: an admin employee requires a channel (e.g. dingtalk)')
      return channel
    }
    if (channel !== undefined) throw new Error('pi-agent: only an admin employee carries a channel')
    return undefined
  }

  /** Resolve the binding: omitted binds the sole admin; ambiguous or unknown ids reject. */
  private resolveManagerId(type: EmployeeTypeId, managerId: string | undefined): string | undefined {
    if (type !== 'pi-coder') {
      if (managerId !== undefined) throw new Error('pi-agent: an admin employee cannot be managed (managerId rejected)')
      return undefined
    }
    if (managerId !== undefined) {
      const manager = this.records.get(managerId)
      if (manager === undefined) throw new Error(`pi-agent: managerId does not resolve to an employee: ${managerId}`)
      if (manager.type !== 'admin') throw new Error(`pi-agent: managerId must point at an admin, not a ${manager.type}`)
      return managerId
    }
    const admins = this.list().filter(employee => employee.type === 'admin')
    if (admins.length > 1) throw new Error('pi-agent: multiple admins exist; pick one explicitly (managerId)')
    return admins[0]?.id
  }

  /** Next "数字程序员 N"-style default name for one type. */
  private defaultName(type: EmployeeTypeId): string {
    const label = EMPLOYEE_TYPES[type].label
    let index = 1
    const taken = new Set(this.list().map(employee => employee.name))
    while (taken.has(`${label} ${index}`)) index += 1
    return `${label} ${index}`
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

  /**
   * Remove and persist one employee. The human path is unrestricted; deleting
   * an admin unbinds its whole team (the employees stay, `managerId` clears).
   */
  async delete(id: string): Promise<void> {
    const removed = this.records.get(id)
    if (removed === undefined) throw new Error(`pi-agent: unknown employee ${id}`)
    this.records.delete(id)
    if (removed.type === 'admin') {
      for (const [employeeId, employee] of this.records) {
        if (employee.managerId !== id) continue
        const { managerId: _managerId, ...unbound } = employee
        void _managerId
        this.records.set(employeeId, unbound)
      }
    }
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
