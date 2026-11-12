import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/types.d.ts
/**
 * Pure wire types of the digital-employee directory: the one home of the
 * employee view and request shapes, free of host-side value imports.
 * @module @deepseek-ai/dsh-pi-agent/types
 */
/** Client-facing employee record. */
interface EmployeeView {
  readonly id: string;
  readonly type: 'pi-coder';
  readonly name: string;
  readonly avatar: string;
  readonly description: string;
  readonly cwd: string;
  readonly piModel?: {
    provider: string;
    modelId: string;
  };
  readonly thinking?: 'off' | 'low' | 'medium' | 'high';
  readonly piSessionFile?: string;
  readonly sessionId?: string;
  readonly createdAt: string;
}
/** One employee creation request. */
interface EmployeeCreateRequest {
  readonly type?: 'pi-coder';
  readonly name?: string;
  readonly avatar?: string;
  readonly description?: string;
  readonly cwd: string;
  readonly piModel?: {
    provider: string;
    modelId: string;
  };
  readonly thinking?: 'off' | 'low' | 'medium' | 'high';
  readonly piSessionFile?: string;
}
/** One employee update request. */
interface EmployeeUpdateRequest {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly cwd?: string;
}
/** One employee deletion request. */
interface EmployeeDeleteRequest {
  readonly id: string;
}
//#endregion
//#region src/index.d.ts
declare const name = "pi-agent";
declare const inject: string[];
/** Default ceiling on simultaneously live pi children per plugin instance. */
declare const DEFAULT_MAX_CHILDREN = 4;
/** Smallest meaningful child ceiling. */
declare const MIN_MAX_CHILDREN = 1;
/** Default executable started for every child. */
declare const DEFAULT_COMMAND = "pi";
/** pi child tool configuration. */
interface Config {
  /** Executable started for every child (default `pi`, resolved from PATH). */
  command?: string;
  /** Extra arguments inserted before pi's own mode arguments. */
  args?: string[];
  /** pi tool selection forwarded to `--tools`; omitted keeps pi's default set. */
  tools?: string;
  /** Provider name forwarded to `--provider`; omitted keeps pi's configuration. */
  provider?: string;
  /** Model id forwarded to `--model`; omitted keeps pi's configuration. */
  model?: string;
  /** Environment map layered over the child environment. */
  env?: Record<string, string>;
  /** Maximum simultaneously live pi children (default 4). */
  maxChildren?: number;
  /** Display title of the digital-employee Workspace group. */
  groupTitle?: string;
}
/** Schemastery configuration for the pi agent tool consumer. */
declare const Config: z<Config>;
/** Validate configuration, prepare durable state, and register the `pi_agent` tool. */
declare function apply(ctx: Context, config?: Config): Promise<void>;
//#endregion
export { Config, DEFAULT_COMMAND, DEFAULT_MAX_CHILDREN, type EmployeeCreateRequest, type EmployeeDeleteRequest, type EmployeeUpdateRequest, type EmployeeView, MIN_MAX_CHILDREN, apply, inject, name };