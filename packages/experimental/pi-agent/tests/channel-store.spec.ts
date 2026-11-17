import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ChannelStore } from '../src/channel-store.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-channel-'))
  dirs.push(dir)
  return join(dir, 'channel.json')
}

describe('ChannelStore', () => {
  it('starts from cordis defaults alone when no file exists', () => {
    const store = ChannelStore.load(storePath(), { dingtalkGroupId: 'cid-default', allowedSenderIds: ['S1'] })
    expect(store.effective()).toEqual({ dingtalkGroupId: 'cid-default', allowedSenderIds: ['S1'] })
  })

  it('a missing file with no defaults yields an empty effective configuration', () => {
    const store = ChannelStore.load(storePath(), {})
    expect(store.effective()).toEqual({})
  })

  it('a malformed file fails loudly', () => {
    const file = storePath()
    writeFileSync(file, 'not-json{', 'utf8')
    expect(() => ChannelStore.load(file, {})).toThrow(/malformed/)
  })

  it('persisted values override the cordis defaults field by field', () => {
    const file = storePath()
    const store = ChannelStore.load(file, { dingtalkGroupId: 'cid-default', allowedSenderIds: ['S1'] })
    store.setGroupId('cid-wizard')
    expect(store.effective().dingtalkGroupId).toBe('cid-wizard')
    expect(store.effective().allowedSenderIds).toEqual(['S1'])
    const reread = ChannelStore.load(file, { dingtalkGroupId: 'cid-default', allowedSenderIds: ['S1'] })
    expect(reread.effective().dingtalkGroupId).toBe('cid-wizard')
  })

  it('setGroupId persists to disk', () => {
    const file = storePath()
    const store = ChannelStore.load(file, {})
    store.setGroupId('cid-x')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ dingtalkGroupId: 'cid-x' })
  })

  describe('capture rounds', () => {
    it('admitting a new sender grows the whitelist, clears pending, and persists', () => {
      const file = storePath()
      const store = ChannelStore.load(file, {})
      store.startCapture()
      expect(store.isCapturePending()).toBe(true)
      expect(store.admitSender('S9')).toBe(true)
      expect(store.isCapturePending()).toBe(false)
      expect(store.effective().allowedSenderIds).toEqual(['S9'])
      const reread = ChannelStore.load(file, {})
      expect(reread.isCapturePending()).toBe(false)
      expect(reread.effective().allowedSenderIds).toEqual(['S9'])
    })

    it('admitting an existing sender dedupes without growing the whitelist', () => {
      const file = storePath()
      const store = ChannelStore.load(file, { allowedSenderIds: ['S1'] })
      store.startCapture()
      expect(store.admitSender('S1')).toBe(false)
      expect(store.effective().allowedSenderIds).toEqual(['S1'])
      expect(store.isCapturePending()).toBe(false)
    })

    it('cancelCapture ends the round without touching the whitelist', () => {
      const file = storePath()
      const store = ChannelStore.load(file, {})
      store.startCapture()
      store.cancelCapture()
      expect(store.isCapturePending()).toBe(false)
      expect(store.effective().allowedSenderIds).toBeUndefined()
    })
  })
})
