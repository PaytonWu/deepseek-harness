import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { DwsTransport } from '../src/admin/dws-transport.ts'

/** A controllable fake child process: records spawn args, replays stdout. */
function fakeChild(): ChildProcess & { emitLine: (line: string) => void; exit: (code: number) => void } {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: () => { void child },
  }) as unknown as ChildProcess & {
    stdout: EventEmitter
    stderr: EventEmitter
    emitLine: (line: string) => void
    exit: (code: number) => void
  }
  child.emitLine = (line) => { child.stdout.emit('data', `${line}\n`) }
  child.exit = (code) => { child.emit('close', code) }
  return child
}

describe('DwsTransport send (T4.2)', () => {
  it('spawns dws chat +send-to-group with the group, content and --yes', async () => {
    const spawn = vi.fn(() => {
      const c = fakeChild()
      setTimeout(() => { c.exit(0) }, 0)
      return c
    })
    const transport = new DwsTransport({ notificationGroupId: 'cid123', spawn: spawn })
    await transport.send('【数字程序员】反馈：\n搞定')
    expect(spawn).toHaveBeenCalledOnce()
    const first = spawn.mock.calls[0]
    if (first === undefined) throw new Error('dws was never spawned')
    const [command, args] = first as unknown as [string, string[]]
    expect(command).toBe('dws')
    expect(args[0]).toBe('chat')
    expect(args).toContain('+send-to-group')
    expect(args).toContain('cid123')
    expect(args).toContain('【数字程序员】反馈：\n搞定')
    expect(args).toContain('--yes')
    void args
  })

  it('rejects when the dws child exits non-zero', async () => {
    const spawn = vi.fn(() => {
      const child = fakeChild()
      setTimeout(() => { child.exit(1) }, 0)
      return child
    })
    const transport = new DwsTransport({ notificationGroupId: 'cid123', spawn: spawn })
    await expect(transport.send('消息')).rejects.toThrow(/non-zero|失败|exit/i)
  })
})

describe('DwsTransport receive (T4.3-M5)', () => {
  it('parses NDJSON events into userId + content and only accepts the configured group', async () => {
    const children: Array<{ emitLine: (line: string) => void }> = []
    const spawn = vi.fn(() => {
      const c = fakeChild()
      children.push(c)
      return c
    })
    const received: Array<{ senderId: string; content: string }> = []
    const transport = new DwsTransport({
      notificationGroupId: 'cidGOOD',
      allowedSenderOpenDingTalkIds: ['D77ZLdiS2VYTllxdpMj5Yxc9ZiPq2NZqhLu'],
      spawn: spawn,
    })
    await transport.start((message) => { received.push(message) })
    const child = children[0]!
    child.emitLine('[event] ready event_key=user_im_message_receive_group bus_pid=1')
    child.emitLine(JSON.stringify({
      type: 'user_im_message_receive_group', conversation_id: 'cidGOOD',
      sender_open_dingtalk_id: 'D77ZLdiS2VYTllxdpMj5Yxc9ZiPq2NZqhLu', content: '让小张跑构建',
    }))
    await vi.waitFor(() => { expect(received).toHaveLength(1) })
    expect(received[0]).toEqual({ senderId: 'D77ZLdiS2VYTllxdpMj5Yxc9ZiPq2NZqhLu', content: '让小张跑构建' })

    // A different group's event is dropped.
    child.emitLine(JSON.stringify({
      type: 'user_im_message_receive_group', conversation_id: 'cidOTHER',
      sender_open_dingtalk_id: 'D77ZLdiS2VYTllxdpMj5Yxc9ZiPq2NZqhLu', content: '别的群',
    }))
    await vi.waitFor(() => { expect(received).toHaveLength(1) })
    void transport
  })

  it('drops pipeline-echo messages (【-prefixed) so notifications never loop back as instructions', async () => {
    const children: Array<{ emitLine: (line: string) => void }> = []
    const spawn = vi.fn(() => {
      const c = fakeChild()
      children.push(c)
      return c
    })
    const received: Array<{ senderId: string; content: string }> = []
    const transport = new DwsTransport({
      notificationGroupId: 'cidGOOD',
      allowedSenderOpenDingTalkIds: ['D77ZLdiS2VYTllxdpMj5Yxc9ZiPq2NZqhLu'],
      spawn: spawn,
    })
    await transport.start((message) => { received.push(message) })
    const child = children[0]!
    child.emitLine(JSON.stringify({
      type: 'user_im_message_receive_group', conversation_id: 'cidGOOD',
      sender_open_dingtalk_id: 'D77ZLdiS2VYTllxdpMj5Yxc9ZiPq2NZqhLu', content: '【码员1】反馈：管道回声',
    }))
    await vi.waitFor(() => { expect(received).toHaveLength(0) })
    void transport
  })
})

describe('DwsTransport supervision (T4.3-M5)', () => {
  it('restarts the listener child after it dies', async () => {
    const spawn = vi.fn(() => fakeChild() as unknown as ChildProcess)
    const transport = new DwsTransport({
      notificationGroupId: 'cidGOOD', restartDelayMs: 0,
      spawn: spawn,
    })
    await transport.start(() => undefined)
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(1) })
    const firstChild = spawn.mock.results[0]?.value as unknown as { exit: (code: number) => void }
    firstChild.exit(1)
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2) })
    await transport.stop()
    expect(spawn.mock.calls.length).toBe(2)
  })

  it('stops the listener and no longer restarts after stop()', async () => {
    const spawn = vi.fn(() => fakeChild() as unknown as ChildProcess)
    const transport = new DwsTransport({
      notificationGroupId: 'cidGOOD', restartDelayMs: 0,
      spawn: spawn,
    })
    await transport.start(() => undefined)
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(1) })
    await transport.stop()
    const callsAfterStop = spawn.mock.calls.length
    const lastChild = spawn.mock.results[callsAfterStop - 1]?.value as unknown as { exit: (code: number) => void }
    lastChild.exit(1)
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(spawn).toHaveBeenCalledTimes(callsAfterStop)
  })
})
