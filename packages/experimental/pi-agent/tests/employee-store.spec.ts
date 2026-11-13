import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { EmployeeStore } from '../src/employee-store.ts'

async function fixture(options: { withCwd?: boolean; withSessionFile?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-employees-'))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const cwd = options.withCwd === false ? undefined : await mkdir(join(dir, 'work'), { recursive: true }).then(() => join(dir, 'work'))
  const piSessionFile = options.withSessionFile === false ? undefined : join(dir, 'prior.jsonl')
  if (piSessionFile !== undefined) await writeFile(piSessionFile, '{"stub":true}\n', 'utf8')
  return {
    dir,
    file: join(dir, 'employees.json'),
    cwd: cwd ?? join(dir, 'work'),
    piSessionFile: piSessionFile ?? join(dir, 'prior.jsonl'),
    store: EmployeeStore.load(join(dir, 'employees.json')),
  }
}

describe('EmployeeStore (T1.1, T1.6) load', () => {
  it('starts empty on a missing file', async () => {
    const { store } = await fixture()
    expect(store.list()).toEqual([])
  })

  it('fails loudly on a malformed file (non-array)', async () => {
    const { dir, file } = await fixture()
    await writeFile(file, '{"nope":true}', 'utf8')
    expect(() => EmployeeStore.load(file)).toThrow(/malformed/)
    void dir
  })

  it('fails loudly on a malformed record (missing required fields)', async () => {
    const { file } = await fixture()
    await writeFile(file, '[{"id":"x"}]', 'utf8')
    expect(() => EmployeeStore.load(file)).toThrow(/malformed/)
  })
})

describe('EmployeeStore (T1.2, T1.3) create', () => {
  it('persists and reloads across instances with unique 8-char ids', async () => {
    const { store, file, cwd } = await fixture()
    const created = await store.create({ name: '数字程序员', description: 'Writes code.', cwd })
    expect(created.id).toMatch(/^[0-9a-f]{8}$/u)
    const second = await store.create({ name: 'Reviewer', description: 'Reviews code.', cwd })
    expect(second.id).not.toBe(created.id)
    const reloaded = EmployeeStore.load(file)
    expect(reloaded.list().map(employee => employee.name)).toEqual(['数字程序员', 'Reviewer'])
  })

  it('fills the type defaults: incremented name, preset emoji and description (T6.1)', async () => {
    const { store, cwd } = await fixture()
    const first = await store.create({ cwd })
    expect(first).toMatchObject({ type: 'pi-coder', name: '数字程序员 1', avatar: '🧑‍💻' })
    expect(first.description).toContain('数字程序员')
    const second = await store.create({ cwd })
    expect(second.name).toBe('数字程序员 2')
  })

  it('stores avatar, piModel, and thinking overrides (T6.1)', async () => {
    const { store, cwd } = await fixture()
    const created = await store.create({ cwd, name: '小明', avatar: '🤖', piModel: { provider: 'deepseek', modelId: 'deepseek-chat' }, thinking: 'high' })
    expect(created).toMatchObject({ avatar: '🤖', piModel: { provider: 'deepseek', modelId: 'deepseek-chat' }, thinking: 'high' })
  })

  it('backfills legacy records without type or avatar on load (T6.1)', async () => {
    const { file, cwd } = await fixture()
    await writeFile(file, JSON.stringify([{ id: 'abcd1234', name: '旧员工', description: 'd', cwd, createdAt: '2026-01-01T00:00:00.000Z' }]), 'utf8')
    const reloaded = EmployeeStore.load(file)
    expect(reloaded.get('abcd1234')).toMatchObject({ type: 'pi-coder', avatar: '🧑‍💻' })
  })

  it('rejects a cwd that is not an existing directory', async () => {
    const { store, dir } = await fixture()
    await expect(store.create({ name: 'n', description: 'd', cwd: join(dir, 'missing') })).rejects.toThrow(/cwd/)
  })

  it('rejects an imported pi session file that does not exist', async () => {
    const { store, cwd, dir } = await fixture()
    await expect(store.create({ name: 'n', description: 'd', cwd, piSessionFile: join(dir, 'nope.jsonl') })).rejects.toThrow(/session/)
  })

  it('rejects a duplicate name', async () => {
    const { store, cwd } = await fixture()
    await store.create({ name: 'n', description: 'd', cwd })
    await expect(store.create({ name: 'n', description: 'other', cwd })).rejects.toThrow(/exists/)
  })

  it('accepts an existing imported pi session file and stores it', async () => {
    const { store, cwd, piSessionFile } = await fixture()
    const created = await store.create({ name: 'n', description: 'd', cwd, piSessionFile })
    expect(store.get(created.id)?.piSessionFile).toBe(piSessionFile)
  })
})

describe('EmployeeStore (T1.4, T1.5) update and delete', () => {
  it('updates fields, persists, and survives reload', async () => {
    const { store, file, cwd } = await fixture()
    const created = await store.create({ name: 'n', description: 'd', cwd })
    await store.update(created.id, { description: 'better', sessionId: 'session-1' })
    expect(store.get(created.id)).toMatchObject({ description: 'better', sessionId: 'session-1' })
    expect(EmployeeStore.load(file).get(created.id)?.description).toBe('better')
  })

  it('rejects updating an unknown id', async () => {
    const { store } = await fixture()
    await expect(store.update('deadbeef', { description: 'x' })).rejects.toThrow(/unknown/)
  })

  it('deletes and persists; rejects an unknown id', async () => {
    const { store, file, cwd } = await fixture()
    const created = await store.create({ name: 'n', description: 'd', cwd })
    await store.delete(created.id)
    expect(store.get(created.id)).toBeUndefined()
    expect(EmployeeStore.load(file).list()).toEqual([])
    await expect(store.delete(created.id)).rejects.toThrow(/unknown/)
  })
})

describe('EmployeeStore (T1.7) persistence hygiene', () => {
  it('writes readable JSON with no temp siblings left behind', async () => {
    const { store, dir, file, cwd } = await fixture()
    await store.create({ name: 'n', description: 'd', cwd })
    expect(existsSync(file)).toBe(true)
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    expect(Array.isArray(parsed)).toBe(true)
    const siblings = (await readdir(dir)).filter(entry => entry.startsWith('employees.json.') || entry.endsWith('.tmp'))
    expect(siblings).toEqual([])
  })
})
