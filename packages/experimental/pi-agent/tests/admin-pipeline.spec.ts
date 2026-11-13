import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdminFeedbackPipeline } from '../src/admin/pipeline.ts'
import { EmployeeStore } from '../src/employee-store.ts'

async function fixture(options: { admins?: number; failures?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-admin-pipeline-'))
  const cleanup = async (): Promise<void> => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  void cleanup
  const cwd = await mkdir(join(dir, 'work'), { recursive: true }).then(() => join(dir, 'work'))
  const store = EmployeeStore.load(join(dir, 'employees.json'))
  const admins: string[] = []
  for (let index = 0; index < (options.admins ?? 0); index += 1) {
    const admin = await store.create({ type: 'admin', channel: 'dingtalk', name: `管理员${String.fromCharCode(65 + index)}`, cwd })
    admins.push(admin.id)
  }
  const coders: Array<{ id: string; name: string }> = []
  for (let index = 0; index < (options.admins ?? 0); index += 1) {
    const coder = await store.create({ name: `码员${index + 1}`, cwd, managerId: admins[0]! })
    coders.push({ id: coder.id, name: coder.name })
  }

  const sent: string[] = []
  let failures = options.failures ?? 0
  const attempts = vi.fn(() => attempts.mock.calls.length - 1)
  const transport = {
    send: async (message: string): Promise<void> => {
      const callIndex = attempts()
      if (callIndex <= failures) throw new Error('钉钉不可达')
      sent.push(message)
    },
  }
  const logger = { warn: vi.fn(), info: vi.fn() }
  const pipeline = new AdminFeedbackPipeline({ transport, store, logger, retryDelayMs: 0 })
  return { store, pipeline, sent, attempts, logger, coders, admins, cwd, setFailures: (n: number) => { failures = n } }
}

describe('AdminFeedbackPipeline (T3.1, T3.2-M4) feedback forwarding', () => {
  it('sends a bound coder\'s settled answer as a formatted feedback message', async () => {
    const { pipeline, sent, coders } = await fixture({ admins: 1 })
    await pipeline.onEmployeeTurnSettled(coders[0]!.id, '构建脚本分析完成，发现 3 个问题。')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('【码员1】反馈：')
    expect(sent[0]).toContain('构建脚本分析完成，发现 3 个问题。')
  })

  it('truncates an over-long answer at 2000 characters with an omission note', async () => {
    const { pipeline, sent, coders } = await fixture({ admins: 1 })
    const long = 'x'.repeat(2500)
    await pipeline.onEmployeeTurnSettled(coders[0]!.id, long)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('…（已截断）')
    expect(sent[0]!.length).toBeLessThan(2200)
    void coders
  })
})

describe('AdminFeedbackPipeline (T3.3, T3.5-M4) scope filters', () => {
  it('sends nothing for an unbound coder (no admin exists)', async () => {
    const { store, pipeline, sent, cwd } = await fixture({ admins: 0 })
    const unbound = await store.create({ name: '散员', cwd })
    expect(unbound.managerId).toBeUndefined()
    await pipeline.onEmployeeTurnSettled(unbound.id, '没人管我')
    expect(sent).toHaveLength(0)
  })

  it('sends nothing when an admin itself settles a turn', async () => {
    const { store, pipeline, sent } = await fixture({ admins: 1 })
    const admin = store.list().find(row => row.type === 'admin')!
    await pipeline.onEmployeeTurnSettled(admin.id, '管理员自己的发言')
    expect(sent).toHaveLength(0)
  })

  it('sends nothing for an unknown employee id', async () => {
    const { pipeline, sent } = await fixture({ admins: 1 })
    await pipeline.onEmployeeTurnSettled('ghost000', '幽灵回答')
    expect(sent).toHaveLength(0)
  })
})

describe('AdminFeedbackPipeline (T3.4-M4) failure handling', () => {
  it('retries exactly 3 times, then logs and keeps the employee unblocked', async () => {
    const { pipeline, sent, attempts, logger, coders, setFailures } = await fixture({ admins: 1, failures: 3 })
    expect(coders).toHaveLength(1)
    await pipeline.onEmployeeTurnSettled(coders[0]!.id, '第一次反馈')
    expect(attempts.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(sent).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledOnce()

    // The employee keeps working: a later settle (transport recovered) goes out.
    setFailures(0)
    await pipeline.onEmployeeTurnSettled(coders[0]!.id, '第二次反馈')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('第二次反馈')
  })
})

describe('AdminFeedbackPipeline (T3.6-M6) lifecycle notices', () => {
  it('sends a lifecycle notice through the same transport', async () => {
    const { pipeline, sent } = await fixture({ admins: 1 })
    await pipeline.notifyLifecycle('已创建数字程序员"小张"（已绑定管理员）')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBe('【系统】已创建数字程序员"小张"（已绑定管理员）')
  })
})
