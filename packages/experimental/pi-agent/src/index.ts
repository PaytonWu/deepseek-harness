/**
 * One model-facing `pi_agent` tool over continuable pi coding-agent child
 * processes. pi owns conversation content in its own session files; this
 * plugin owns child identity, process lifecycle, and a durable pointer
 * registry under the Harness home.
 * @module @deepseek-ai/dsh-pi-agent
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'pi-agent'
export const inject = ['tools', 'workingDirectory']

/** Default ceiling on simultaneously live pi children per plugin instance. */
export const DEFAULT_MAX_CHILDREN = 4
/** Smallest meaningful child ceiling. */
export const MIN_MAX_CHILDREN = 1

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
  command: z.string().default('pi'),
  args: z.array(z.string()).default([]),
  tools: z.string(),
  provider: z.string(),
  model: z.string(),
  env: z.dict(z.string()).default({}),
  maxChildren: z.number().step(1).min(MIN_MAX_CHILDREN).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_CHILDREN),
})

/** Validate configuration and register the pi delegation tool. */
export function apply(ctx: Context, config: Config = {}): void {
  const command = config.command ?? 'pi'
  if (command.length === 0) throw new Error('pi-agent: command must be a non-empty string')
  const maxChildren = config.maxChildren ?? DEFAULT_MAX_CHILDREN
  if (!Number.isSafeInteger(maxChildren) || maxChildren < MIN_MAX_CHILDREN) {
    throw new Error(`pi-agent: maxChildren must be a safe integer of at least ${MIN_MAX_CHILDREN}`)
  }
  void ctx
}
