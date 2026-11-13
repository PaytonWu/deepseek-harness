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
import { PiChildManager } from './manager.ts'
import { EmployeeStore } from './employee-store.ts'
import type { EmployeeRecord } from './employee-store.ts'
import { EmployeeDirectoryService } from './employee-directory.ts'
import { PI_EMPLOYEE_PROVIDER, PiEmployeeAdapter } from './employee-adapter.ts'
import { AdminFeedbackPipeline } from './admin/pipeline.ts'
import { DwsTransport } from './admin/dws-transport.ts'
import { AdminInboundDispatcher } from './admin/inbound.ts'
import { newEmployeeCommand } from './employee-command.ts'
export type { EmployeeCreateRequest, EmployeeDeleteRequest, EmployeeUpdateRequest, EmployeeView } from './types.ts'

export const name = 'pi-agent'
export const inject = ['tools', 'workingDirectory', 'systemPrompt', 'llm', 'agents', 'workspaceRegistry']

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
  /** Display title of the digital-employee Workspace group. */
  groupTitle?: string
  /** DingTalk notification group's openConversationId; set to enable the admin channel. */
  dingtalkGroupId?: string
  /** Whitelisted sender openDingTalkIds allowed to instruct admins. */
  dingtalkAllowedSenderIds?: string[]
  /** Who answers inbound admin instructions: 'admin' routes through the admin session; 'echo' sends an acknowledgement only. */
  dingtalkInboundReply?: string
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
  groupTitle: z.string().default('我的数字员工'),
  dingtalkGroupId: z.string(),
  dingtalkAllowedSenderIds: z.array(z.string()).default([]),
  dingtalkInboundReply: z.string().default('admin'),
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
  state: { type: 'string', required: true, enum: ['running', 'idle', 'inactive'] },
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
  return children.map((child) => {
    const answer = child.lastResult === undefined ? '' : `\n  last result: ${child.lastResult.slice(0, 2_000)}`
    return `- ${child.childId} — ${child.state} — ${child.cwd}${answer}`
  }).join('\n')
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('pi_agent requires an initiating agent')
  return agent
}

function requireChildId(args: PiAgentArgs): string {
  if (args.childId === undefined || args.childId.length === 0) throw new Error('childId is required for this operation')
  return args.childId
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
  const store = EmployeeStore.load(resolve(paths.root, 'employees.json'))
  const registry = PiChildRegistry.load({ file: paths.registryFile, sessionsDir: paths.sessions })
  await registry.sweepOrphans((line) => { ctx.logger.warn(line) })
  const spawnOptions = {
    command,
    args: config.args ?? [],
    sessionDir: paths.sessions,
    ...config.tools !== undefined ? { tools: config.tools } : {},
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
    env: config.env ?? {},
  }
  const manager = new PiChildManager(registry, spawnOptions)

  ctx.effect(() => () => { void manager.disposeAll() })

  const ensureInFlight = new Map<string, Promise<{ child: PiRpcChild; createdFresh: boolean }>>()
  const ensureChild = async (employee: EmployeeRecord): Promise<{ child: PiRpcChild; createdFresh: boolean }> => {
    const existing = manager.live(employee.id)
    if (existing !== undefined) return { child: existing, createdFresh: false }
    const inFlight = ensureInFlight.get(employee.id)
    if (inFlight !== undefined) return inFlight
    const ensured = manager.ensureForEmployee(employee).then(async (result) => {
      if (result.createdFresh && result.child.sessionFile !== undefined) {
        await store.bindSessionFile(employee.id, result.child.sessionFile)
      }
      return result
    })
    ensureInFlight.set(employee.id, ensured)
    try {
      return await ensured
    } finally {
      ensureInFlight.delete(employee.id)
    }
  }
  ctx.llm.registerAdapter([PI_EMPLOYEE_PROVIDER], new PiEmployeeAdapter({
    employeeOf: employeeId => store.get(employeeId),
    ensureChild,
  }))
  // The DingTalk management channel: feedback relay + inbound instruction
  // dispatch. Inbound instructions from whitelisted senders go through the
  // admin's own pi session; the settled answer goes back out over IM.
  if (config.dingtalkGroupId !== undefined) {
    const transport = new DwsTransport({ notificationGroupId: config.dingtalkGroupId })
    const pipeline = new AdminFeedbackPipeline({
      transport,
      store,
      logger: { warn: (message) => { ctx.logger.warn(message) } },
    })
    const dispatchers = new Map<string, AdminInboundDispatcher>()
    const inbound = new AdminInboundDispatcher({
      store,
      ensureForAdmin: async (adminId: string) => {
        const record = store.get(adminId)
        if (record === undefined) throw new Error(`pi-agent: unknown admin ${adminId}`)
        const { child } = await ensureChild(record)
        return {
          inject: async (text: string) => { await child.sendPrompt(text) },
          answer: async () => (await child.lastAssistantText()) ?? '',
        }
      },
      transport,
      whitelist: config.dingtalkAllowedSenderIds ?? [],
      logger: { warn: (message) => { ctx.logger.warn(message) } },
      adminOnline: true,
    })
    void inbound
    void dispatchers
    const adapterSettled = (employeeId: string, answer: string): void => {
      void pipeline.onEmployeeTurnSettled(employeeId, answer).catch(() => undefined)
    }
    void adapterSettled
    ctx.effect(() => async () => {
      await transport.start((message) => {
        // Reply routing: 'admin' injects through the admin session (the
        // dispatcher), 'echo' answers an acknowledgement only (the channel's
        // liveness check while no admin persona exists yet).
        if (config.dingtalkInboundReply === 'echo') {
          void transport.send(`【数字管理员】已收到：${message.content}`).catch(() => undefined)
          return
        }
        void inbound.dispatch(message)
      })
    }, 'pi-agent: dingtalk channel')
  }
  const directory = new EmployeeDirectoryService(ctx, {
    store,
    disposeChild: async (employeeId) => {
      const live = manager.live(employeeId)
      if (live !== undefined) await live.dispose()
    },
    isChildLive: employeeId => manager.live(employeeId) !== undefined,
    ensureChild: async (employee) => {
      const { child } = await ensureChild(employee)
      return { child: { sendPrompt: (text: string) => child.sendPrompt(text) } }
    },
    listPiModels: async () => {
      const probe = PiRpcChild.start({ ...spawnOptions, cwd: paths.root })
      try {
        await probe.ready()
        const models = await probe.availableModels()
        return models.map(model => ({ provider: model.provider, modelId: model.id, name: model.name }))
      } finally {
        await probe.dispose().catch(() => undefined)
      }
    },
  }, config.groupTitle ?? '我的数字员工')
  const warmup = async (): Promise<void> => { await directory.warmup() }
  void warmup().catch(() => undefined)
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(function* () {
      yield commandCtx.commands.register(newEmployeeCommand(input => directory.create(input)))
    }, 'pi-agent command lifecycle')
  })

  ctx.systemPrompt.section({
    name: 'tool:pi-agent',
    order: ctx.systemPrompt.getSectionOrder('TOOL_PI_AGENT'),
    text: 'Use pi_agent only when the operator explicitly asks for pi. This channel is separate from dsh subagents: pi children do not appear in list_agents and cannot receive subagent messages. start returns a childId immediately; poll status for the answer, send for follow-ups, interrupt to stop a running turn. Children survive Host restarts; an inactive child resumes on send.',
  })

  ctx.tools.register(defineTool({
    name: 'pi_agent',
    description: 'Delegate a coding task to a pi coding-agent child and keep it continuable. This is a dedicated pi channel: pi children are not dsh subagents, do not appear in list_agents, and use pi\'s own session, model, and credentials. Use it only when the operator explicitly asks for pi.',
    parameters: {
      op: { type: 'string', required: true, enum: ['start', 'send', 'interrupt', 'status', 'list'], description: 'Operation: start, send, interrupt, status, or list.' },
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
            properties: { kind: { type: 'string', required: true, const: 'sent' }, childId: { type: 'string', required: true }, state: { type: 'string', required: true, enum: ['running', 'idle'] } },
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
        const created = await manager.create(resolved, args.task)
        return { kind: 'started', childId: created.id, state: 'running' } as const
      }

      if (args.op === 'send') {
        if (args.message === undefined || args.message.length === 0) throw new Error('send requires a non-empty message')
        const childId = requireChildId(args)
        const record = registry.get(childId)
        if (record === undefined) throw new Error(`pi-agent: unknown child ${childId}`)
        const live = manager.live(childId) ?? await manager.attach(childId, record.sessionFile, record.cwd)
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
