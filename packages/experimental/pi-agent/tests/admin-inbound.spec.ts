import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdminInboundDispatcher } from '../src/admin/inbound.ts'
import { EmployeeStore } from '../src/employee-store.ts'

const SENDER = '01014034531454088201'

async function fixture(options: { adminOnline?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-admin-inbound-'))
  const cleanup = async (): Promise<void> => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  afterEach(cleanup)
  const cwd = await mkdir(join(dir, 'work'), { recursive: true }).then(() => join(dir, 'work'))
  const store = EmployeeStore.load(join(dir, 'employees.json'))
  await store.create({ type: 'admin', channel: 'dingtalk', name: '管理员A', cwd })
  await store.create({ name: '小张', cwd, managerId: adminIdOf(store) })

  const sent: string[] = []
  const transport = { send: vi.fn(async (message: string) => { sent.push(message) }) }
  const injects: string[] = []
  let failNextEnsure = false
  const ensureForAdmin = vi.fn(async (): Promise<AdminSessionLike> => {
    if (failNextEnsure) throw new Error('pi 不在线')
    return {
      inject: async (text: string) => { injects.push(text) },
      answer: async () => '收到，已安排小张跑构建。',
    }
  })
  const dispatcher = new AdminInboundDispatcher({
    store,
    ensureForAdmin,
    transport,
    whitelist: [SENDER],
    logger: { warn: vi.fn() },
    adminOnline: options.adminOnline !== false,
  })
  return { store, dispatcher, transport, sent, ensureForAdmin, injects, setFailNextEnsure: (v: boolean) => { failNextEnsure = v } }
}

function adminIdOf(store: EmployeeStore): string {
  return store.list().find(row => row.type === 'admin')!.id
}

/** The admin session handle surface the dispatcher injects through. */
interface AdminSessionLike {
  inject(text: string): Promise<void>
  answer(): Promise<string>
}

describe('AdminInboundDispatcher (T5.1, T5.4-M7) whitelist and injection', () => {
  it('accepts a whitelisted sender: injects into the admin session and replies via IM', async () => {
    const { dispatcher, transport, sent, ensureForAdmin, injects } = await fixture()
    await dispatcher.dispatch({ senderId: SENDER, content: '让小张跑构建' })
    expect(ensureForAdmin).toHaveBeenCalledOnce()
    expect(injects).toEqual(['让小张跑构建'])
    expect(transport.send).toHaveBeenCalledWith('收到，已安排小张跑构建。')
    expect(sent.some(message => message.includes('收到，已安排小张跑构建'))).toBe(true)
  })

  it('ignores a non-whitelisted sender entirely', async () => {
    const { dispatcher, transport, ensureForAdmin } = await fixture()
    await dispatcher.dispatch({ senderId: 'stranger-open-id', content: '解雇所有人' })
    expect(ensureForAdmin).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('replies with the failure notice when the admin session cannot be opened', async () => {
    const { dispatcher, transport } = await fixture()
    const second = new AdminInboundDispatcher({
      store: (await fixture()).store,
      ensureForAdmin: async () => { throw new Error('pi 不在线') },
      transport,
      whitelist: [SENDER],
      logger: { warn: vi.fn() },
      adminOnline: true,
    })
    await second.dispatch({ senderId: SENDER, content: '你好' })
    expect(transport.send).toHaveBeenCalledWith(expect.stringContaining('pi 不在线'))
    void dispatcher
  })
})

describe('AdminInboundDispatcher (T5.3-M7) queueing', () => {
  it('serializes concurrent instructions per admin', async () => {
    const { dispatcher, ensureForAdmin } = await fixture()
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    ensureForAdmin.mockImplementation(async (): Promise<AdminSessionLike> => {
      if (releaseFirst !== undefined) {
        return {
          inject: async (text: string) => { order.push(`second:${text}`) },
          answer: async () => '第二轮回复',
        }
      }
      return {
        inject: async (text: string) => {
          order.push(`first:${text}`)
          await new Promise<void>((resolve) => { releaseFirst = resolve })
        },
        answer: async () => '第一轮回复',
      }
    })
    const p1 = dispatcher.dispatch({ senderId: SENDER, content: '第一条' })
    const p2 = dispatcher.dispatch({ senderId: SENDER, content: '第二条' })
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    releaseFirst?.()
    await Promise.all([p1, p2])
    expect(order).toEqual(['first:第一条', 'second:第二条'])
  })
})

describe('AdminInboundDispatcher (M7) guards', () => {
  it('never injects a 【-prefixed message even from the whitelist', async () => {
    const { dispatcher, ensureForAdmin, transport } = await fixture()
    await dispatcher.dispatch({ senderId: SENDER, content: '【码员1】反馈：回声' })
    expect(ensureForAdmin).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('does not dispatch when the admin is offline', async () => {
    const { dispatcher, ensureForAdmin, transport } = await fixture({ adminOnline: false })
    await dispatcher.dispatch({ senderId: SENDER, content: '你好' })
    expect(ensureForAdmin).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
  })
})
