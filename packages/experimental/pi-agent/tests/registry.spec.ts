import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { PiChildRegistry } from '../src/registry.ts'

async function tempRegistry() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-registry-'))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
  const file = join(dir, 'children.json')
  const sessionsDir = join(dir, 'sessions')
  return { registry: PiChildRegistry.load({ file, sessionsDir }), file, sessionsDir, dir }
}

describe('PiChildRegistry', () => {
  it('starts empty on a missing file and persists create and update', async () => {
    const { registry, file } = await tempRegistry()
    expect(registry.list()).toEqual([])
    const record = await registry.create({ sessionFile: 's.jsonl', cwd: 'C:/work', pid: 4242 })
    expect(registry.get(record.id)?.state).toBe('running')
    await registry.update(record.id, { state: 'inactive', lastResult: 'OK' })
    const stored = JSON.parse(await readFile(file, 'utf8')) as Array<{ id: string; state: string; lastResult?: string }>
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: record.id, state: 'inactive', lastResult: 'OK', sessionFile: 's.jsonl' })
    expect('pid' in stored[0]!).toBe(false)
  })

  it('reloads persisted records across instances', async () => {
    const { registry, file, sessionsDir } = await tempRegistry()
    const record = await registry.create({ sessionFile: 's.jsonl', cwd: 'C:/work' })
    const reloaded = PiChildRegistry.load({ file, sessionsDir })
    expect(reloaded.get(record.id)?.cwd).toBe('C:/work')
  })

  it('fails loudly on a malformed registry file', async () => {
    const { file, sessionsDir, dir } = await tempRegistry()
    await writeFile(join(dir, 'children.json'), '{"nope":true}', 'utf8')
    expect(() => PiChildRegistry.load({ file, sessionsDir })).toThrow(/malformed/)
  })

  it('sweeps a stale running record only after a command-line check, and marks it inactive', async () => {
    const { registry } = await tempRegistry()
    // this test process is alive but is not a pi RPC child, so the sweep must skip the kill
    await registry.create({ sessionFile: 's.jsonl', cwd: process.cwd(), pid: process.pid })
    const warnings: string[] = []
    const killed = await registry.sweepOrphans((line) => { warnings.push(line) })
    expect(killed).toBe(0)
    expect(registry.list()[0]!.state).toBe('inactive')
    expect(warnings.every(line => line.includes('skipped') || line.includes('could not'))).toBe(true)
  })

  it('leaves inactive records untouched by the sweep', async () => {
    const { registry } = await tempRegistry()
    const record = await registry.create({ sessionFile: 's.jsonl', cwd: process.cwd() })
    await registry.update(record.id, { state: 'inactive' })
    const killed = await registry.sweepOrphans(() => { throw new Error('no warnings expected') })
    expect(killed).toBe(0)
    expect(existsSync(registry.get(record.id)!.sessionFile)).toBe(false)
  })
})
