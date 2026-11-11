/**
 * One model-facing `pi_agent` tool over continuable pi coding-agent child
 * processes. pi owns conversation content in its own session files; this
 * plugin owns child identity, process lifecycle, and a durable pointer
 * registry under the Harness home.
 * @module @deepseek-ai/dsh-pi-agent
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { PiChildRegistry, ensurePiAgentDirs } from './registry.ts'
import type { PiChildRecord } from './registry.ts'
import { PiRpcChild } from './rpc.ts'

export const name = 'pi-agent'
export const inject = ['tools', 'workingDirectory', 'systemPrompt']

/** Default ceiling on simultaneously live pi children per plugin instance. */
export const DEFAULT_MAX_CHILDREN = 4
/** Smallest meaningful child ceiling. */
export const MIN_MAX_CHILDREN = 1
/** Default executable started for every child. */
export const DEFAULT_COMMAND = 'pi'

/** pi child tool configuration. */
export interface Config {
  /** Executable started for every child (default `pi`, resolved from PATH). */
  command?: string
  /** Extra arguments inserted before pi's own mode arguments. */
  args?: string[]
  /** pi tool selection forwarded to `--tools`; omitted keeps pi's default set. */
  tools?: string
  /** Provider name forwarded to `--provider`; omitted keeps pi's configuration. */
  provider?: string
  /** Model id forwarded to `--model`; omitted keeps pi's configuration. */
  model?: string
  /** Environment map layered over the child environment. */
  env?: Record<string, string>
  /** Maximum simultaneously live pi children (default 4). */
  maxChildren?: number
}

/** Schemastery configuration for the pi agent tool consumer. */
export const Config: z<Config> = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  args: z.array(z.string()).default([]),
  tools: z.string(),
  provider: z.string(),
  model: z.string(),
  env: z.dict(z.string()).default({}),
  maxChildren: z.number().step(1).min(MIN_MAX_CHILDREN).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_CHILDREN),
})

interface PiAgentArgs {
  op: 'start' | 'send' | 'interrupt' | 'status' | 'list'
  task?: string
  childId?: string
  message?: string
  cwd?: string
}

interface ChildSummary {
  childId: string
  state: 'running' | 'idle' | 'inactive'
  cwd: string
  sessionFile: string
  lastResult?: string
}

type PiAgentResult =
  | { kind: 'started'; childId: string; state: 'running' }
  | { kind: 'sent'; childId: string; state: 'running' | 'idle' }
  | { kind: 'interrupted'; childId: string; state: 'idle' }
  | { kind: 'status'; children: ChildSummary[] }
  | { kind: 'list'; children: ChildSummary[] }

const CHILD_SUMMARY_PROPERTIES = {
  childId: { type: 'string', required: true },
  state: { type: 'string', required: true, oneOf: [{ const: 'running' }, { const: 'idle' }, { const: 'inactive' }] },
  cwd: { type: 'string', required: true },
  sessionFile: { type: 'string', required: true },
  lastResult: { type: 'string' },
} as const

function summary(record: PiChildRecord, live: PiRpcChild | undefined): ChildSummary {
  const state: ChildSummary['state'] = live === undefined || live.hasExited ? 'inactive' : live.isStreaming ? 'running' : 'idle'
  const lastResult = record.lastResult === undefined || record.lastResult === '' ? undefined : record.lastResult
  return { childId: record.id, state, cwd: record.cwd, sessionFile: record.sessionFile, ...lastResult !== undefined ? { lastResult } : {} }
}

function summariesText(children: readonly ChildSummary[]): string {
  if (children.length === 0) return 'No pi children recorded.'
  return children.map(child => `- ${child.childId} — ${child.state} — ${child.cwd}`).join('\n')
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('pi_agent requires an initiating agent')
  return agent
}

function requireChildId(args: PiAgentArgs): string {
  if (args.childId === undefined || args.childId.length === 0) throw new Error('childId is required for this operation')
  return args.childId
}

/** Fixed spawn inputs shared by every child of one plugin instance. */
interface SpawnInputs {
  command: string
  args: readonly string[]
  sessionDir: string
  tools?: string
  provider?: string
  model?: string
  env: Readonly<Record<string, string>>
}

/** Live child processes keyed by their durable record ids. */
class PiChildManager {
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

  /** Start a new child, persist its record, and deliver the first task. */
  async create(cwd: string, task: string): Promise<PiChildRecord> {
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
    return record
  }

  /** Cold-resume one recorded child from its pi session file. */
  async attach(record: PiChildRecord): Promise<PiRpcChild> {
    const child = PiRpcChild.start({ ...this.spawnOptions, cwd: record.cwd, sessionFile: record.sessionFile })
    this.children.set(record.id, child)
    this.watchExit(record.id, child)
    await this.registry.update(record.id, { state: 'running', ...child.pid !== undefined ? { pid: child.pid } : {} })
    return child
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
    void child.waitExit().then(() => this.registry.update(id, { state: 'inactive' }).catch(() => undefined))
  }
}

/** Validate configuration, prepare durable state, and register the `pi_agent` tool. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const command = config.command ?? DEFAULT_COMMAND
  if (command.length === 0) throw new Error('pi-agent: command must be a non-empty string')
  const maxChildren = config.maxChildren ?? DEFAULT_MAX_CHILDREN
  if (!Number.isSafeInteger(maxChildren) || maxChildren < MIN_MAX_CHILDREN) {
    throw new Error(`pi-agent: maxChildren must be a safe integer of at least ${MIN_MAX_CHILDREN}`)
  }

  const paths = await ensurePiAgentDirs()
  const registry = PiChildRegistry.load({ file: paths.registryFile, sessionsDir: paths.sessions })
  await registry.sweepOrphans((line) => { ctx.logger.warn(line) })
  const manager = new PiChildManager(registry, {
    command,
    args: config.args ?? [],
    sessionDir: paths.sessions,
    ...config.tools !== undefined ? { tools: config.tools } : {},
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
    env: config.env ?? {},
  })

  ctx.effect(() => () => { void manager.disposeAll() })

  ctx.systemPrompt.section({
    name: 'tool:pi-agent',
    order: ctx.systemPrompt.getSectionOrder('TOOL_PI_AGENT'),
    text: 'Use pi_agent only when the operator explicitly asks for pi. This channel is separate from dsh subagents: pi children do not appear in list_agents and cannot receive subagent messages. start returns a childId immediately; poll status for the answer, send for follow-ups, interrupt to stop a running turn. Children survive Host restarts; an inactive child resumes on send.',
  })

  ctx.tools.register(defineTool({
    name: 'pi_agent',
    description: 'Delegate a coding task to a pi coding-agent child and keep it continuable. This is a dedicated pi channel: pi children are not dsh subagents, do not appear in list_agents, and use pi\'s own session, model, and credentials. Use it only when the operator explicitly asks for pi.',
    parameters: {
      op: { type: 'string', required: true, oneOf: [{ const: 'start' }, { const: 'send' }, { const: 'interrupt' }, { const: 'status' }, { const: 'list' }], description: 'Operation: start, send, interrupt, status, or list.' },
      task: { type: 'string', description: 'start: one self-contained task text for the new child.' },
      message: { type: 'string', description: 'send: follow-up message for the child; an inactive child resumes from its pi session.' },
      childId: { type: 'string', description: 'Target child id from start or list.' },
      cwd: { type: 'string', description: 'start: working directory, relative to the Session current directory when not absolute (default: current directory).' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            properties: { kind: { type: 'string', required: true, const: 'started' }, childId: { type: 'string', required: true }, state: { type: 'string', required: true, const: 'running' } },
          },
          {
            type: 'object', additionalProperties: false,
            properties: { kind: { type: 'string', required: true, const: 'sent' }, childId: { type: 'string', required: true }, state: { type: 'string', required: true, oneOf: [{ const: 'running' }, { const: 'idle' }] } },
          },
          {
            type: 'object', additionalProperties: false,
            properties: { kind: { type: 'string', required: true, const: 'interrupted' }, childId: { type: 'string', required: true }, state: { type: 'string', required: true, const: 'idle' } },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'status' },
              children: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: CHILD_SUMMARY_PROPERTIES } },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'list' },
              children: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: CHILD_SUMMARY_PROPERTIES } },
            },
          },
        ],
      } as const,
      render: (_args: PiAgentArgs, value: PiAgentResult): ContentBlock[] => {
        if (value.kind === 'started') return [{ type: 'text', text: `pi child ${value.childId} started and running; poll pi_agent status for the answer.` }]
        if (value.kind === 'sent') return [{ type: 'text', text: `message delivered to pi child ${value.childId} (${value.state}); poll pi_agent status for the answer.` }]
        if (value.kind === 'interrupted') return [{ type: 'text', text: `pi child ${value.childId} interrupted and idle.` }]
        return [{ type: 'text', text: `${value.kind === 'status' ? 'pi children status' : 'pi children'}:\n${summariesText(value.children)}` }]
      },
    },
    presentCall: (args: PiAgentArgs): ToolCallView => {
      const subject = args.op === 'start'
        ? 'Start pi child'
        : args.op === 'send'
          ? `Message ${args.childId ?? 'pi child'}`
          : args.op === 'interrupt'
            ? `Interrupt ${args.childId ?? 'pi child'}`
            : args.op === 'status'
              ? `Status ${args.childId ?? 'of pi children'}`
              : 'List pi children'
      return { card: 'generic', title: subject, kind: 'execute' }
    },
    async execute(args: PiAgentArgs, exec) {
      exec.signal.throwIfAborted()

      if (args.op === 'start') {
        if (args.task === undefined || args.task.length === 0) throw new Error('start requires a non-empty task')
        if (manager.liveCount() >= maxChildren) throw new Error(`pi-agent: maxChildren (${String(maxChildren)}) live children reached; interrupt or wait for a child to finish`)
        const agent = requireAgent(exec.agent)
        const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
        const resolved = args.cwd === undefined ? cwd : resolve(cwd, args.cwd)
        const record = await manager.create(resolved, args.task)
        return { kind: 'started', childId: record.id, state: 'running' } as const
      }

      if (args.op === 'send') {
        if (args.message === undefined || args.message.length === 0) throw new Error('send requires a non-empty message')
        const childId = requireChildId(args)
        const record = registry.get(childId)
        if (record === undefined) throw new Error(`pi-agent: unknown child ${childId}`)
        const live = manager.live(childId) ?? await manager.attach(record)
        await live.sendPrompt(args.message)
        manager.observeSettled(childId, live)
        return { kind: 'sent', childId, state: live.isStreaming ? 'running' as const : 'idle' as const } as const
      }

      if (args.op === 'interrupt') {
        const childId = requireChildId(args)
        const live = manager.live(childId)
        if (live === undefined) throw new Error(`pi-agent: child ${childId} is not running`)
        await live.interrupt()
        const text = await live.lastAssistantText()
        await registry.update(childId, { lastResult: text ?? '' })
        return { kind: 'interrupted', childId, state: 'idle' } as const
      }

      if (args.op === 'status') {
        const childId = args.childId
        const records = childId === undefined ? registry.list() : registry.list().filter(record => record.id === childId)
        if (childId !== undefined && records.length === 0) throw new Error(`pi-agent: unknown child ${childId}`)
        const children = await Promise.all(records.map(async (record) => {
          const live = manager.live(record.id)
          if (live === undefined) return summary(record, undefined)
          if (!live.isStreaming) {
            const text = await live.lastAssistantText().catch(() => undefined)
            if (text !== undefined && record.lastResult !== text) await registry.update(record.id, { lastResult: text })
            return summary(registry.get(record.id) ?? record, live)
          }
          return summary(record, live)
        }))
        return { kind: 'status', children } as const
      }

      const children = registry.list().map(record => summary(record, manager.live(record.id)))
      return { kind: 'list', children } as const
    },
  }))
}
