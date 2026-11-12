import { join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { spawn } from "cross-spawn";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { SessionId } from "@deepseek-ai/dsh-session";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
//#region src/registry.ts
/**
* Durable pointer registry for pi children: one record per child mapping the
* model-facing id to the pi session file, run state, and working directory.
* Stored under the Harness home so backup, cleanup, and uninstall follow it.
* @module pi-registry
*/
const execFileAsync = promisify(execFile);
/** Where the registry file and pi sessions live under the Harness home. */
function piAgentPaths() {
	const root = dshHomePath("pi-agent");
	return {
		root,
		sessions: join(root, "sessions"),
		registryFile: join(root, "children.json")
	};
}
/** Load and persist child records; sweep assumed-running leftovers from a crashed Host. */
var PiChildRegistry = class PiChildRegistry {
	file;
	sessionsDir;
	records = /* @__PURE__ */ new Map();
	constructor(file, sessionsDir) {
		this.file = file;
		this.sessionsDir = sessionsDir;
	}
	/** Load the registry; a missing file starts empty, a malformed file fails loudly. */
	static load(paths) {
		const registry = new PiChildRegistry(paths.file, paths.sessionsDir);
		if (!existsSync(paths.file)) return registry;
		const parsed = JSON.parse(readFileSync(paths.file, "utf8"));
		if (!Array.isArray(parsed)) throw new Error(`pi-agent: registry file ${paths.file} is malformed (expected an array)`);
		for (const entry of parsed) {
			const record = entry;
			if (typeof record.id !== "string" || typeof record.sessionFile !== "string" || typeof record.cwd !== "string") throw new Error(`pi-agent: registry file ${paths.file} is malformed (a child record misses required fields)`);
			registry.records.set(record.id, record);
		}
		return registry;
	}
	/** All records in creation order. */
	list() {
		return [...this.records.values()];
	}
	/** One record by id. */
	get(id) {
		return this.records.get(id);
	}
	/** Create and persist one running record. */
	async create(input) {
		const record = {
			id: randomUUID().slice(0, 8),
			sessionFile: input.sessionFile,
			...input.sessionId !== void 0 ? { sessionId: input.sessionId } : {},
			cwd: input.cwd,
			state: "running",
			...input.pid !== void 0 ? { pid: input.pid } : {},
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		this.records.set(record.id, record);
		await this.save();
		return record;
	}
	/** Patch and persist one record. */
	async update(id, patch) {
		const record = this.records.get(id);
		if (record === void 0) throw new Error(`pi-agent: unknown child ${id}`);
		const next = {
			...record,
			...patch
		};
		this.records.set(id, next);
		await this.save();
		return next;
	}
	async save() {
		const entries = [...this.records.values()].map((record) => {
			const clean = { ...record };
			if (clean.state === "inactive") delete clean.pid;
			return clean;
		});
		await writeFileAtomic(this.file, `${JSON.stringify(entries, void 0, 2)}\n`, {
			mode: 384,
			dirMode: 448
		});
	}
	/**
	* Kill processes left over from a crashed Host. A pid is killed only when
	* its command line still names this registry's pi sessions directory;
	* uncertain checks are skipped with a warning.
	* @param warn - Receives one line per skipped or killed leftover.
	* @returns Number of verified leftovers killed.
	*/
	async sweepOrphans(warn) {
		let killed = 0;
		for (const record of this.records.values()) {
			if (record.state !== "running" || record.pid === void 0) continue;
			const commandLine = await commandLineOf(record.pid);
			if (commandLine === void 0) warn(`pi-agent: leftover child ${record.id} (pid ${String(record.pid)}) has an unverifiable command line; skipped`);
			else if (commandLine.includes(this.sessionsDir) || isPiRpcCommand(commandLine)) if (killProcess(record.pid)) {
				await waitForProcessExit(record.pid);
				killed += 1;
				warn(`pi-agent: killed leftover child ${record.id} (pid ${String(record.pid)})`);
			} else warn(`pi-agent: leftover child ${record.id} (pid ${String(record.pid)}) could not be terminated; skipped`);
			await this.update(record.id, { state: "inactive" });
		}
		return killed;
	}
};
function isPiRpcCommand(commandLine) {
	return /(^|[/\\])pi(\.cmd|\.exe)?(["\s]|$)/iu.test(commandLine) && commandLine.includes("--mode") && commandLine.includes("rpc");
}
async function commandLineOf(pid) {
	try {
		if (process.platform === "win32") {
			const { stdout } = await execFileAsync("powershell.exe", [
				"-NoProfile",
				"-Command",
				`(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`
			], { timeout: 5e3 });
			const line = stdout.trim();
			return line === "" ? void 0 : line;
		}
		if (process.platform === "linux") {
			const { stdout } = await execFileAsync("cat", [`/proc/${String(pid)}/cmdline`], { timeout: 5e3 });
			return stdout.replaceAll("\0", " ").trim();
		}
		if (process.platform === "darwin") {
			const { stdout } = await execFileAsync("ps", [
				"-p",
				String(pid),
				"-o",
				"command="
			], { timeout: 5e3 });
			const line = stdout.trim();
			return line === "" ? void 0 : line;
		}
		return;
	} catch {
		return;
	}
}
/** Wait until one pid is gone, bounded, so a sweep returns only after its kill landed. */
async function waitForProcessExit(pid) {
	const deadline = Date.now() + 5e3;
	while (Date.now() < deadline) try {
		process.kill(pid, 0);
		await new Promise((resolve) => {
			setTimeout(resolve, 100);
		});
	} catch {
		return;
	}
}
function killProcess(pid) {
	try {
		process.kill(pid, process.platform === "win32" ? void 0 : "SIGTERM");
		return true;
	} catch {
		return false;
	}
}
/** Create the plugin's directories under the Harness home. */
async function ensurePiAgentDirs() {
	const paths = piAgentPaths();
	await mkdir(paths.sessions, { recursive: true });
	return paths;
}
//#endregion
//#region src/rpc.ts
/**
* One pi coding-agent child in RPC mode. Owns the spawned process, JSONL
* command/response correlation, and run-state observation; the wire contract
* is documented with the installed pi package.
* @module pi-rpc
*/
/** Graceful-termination wait before forceful kill, milliseconds. */
const DISPOSE_GRACE_MS = 3e3;
/** Bounded wait for `abort` to settle the child, milliseconds. */
const ABORT_WAIT_MS = 6e4;
/** Bounded wait for one command response, milliseconds. */
const COMMAND_TIMEOUT_MS = 12e4;
/** Bounded characters kept from one pi answer. */
const MAX_RESULT_CHARS = 16384;
/** pi is not resolvable from the Host process environment. */
var PiMissingError = class extends Error {
	constructor(command, cause) {
		super(`pi-agent: "${command}" could not be started (${cause.message}). Install pi so it is resolvable from the Host PATH; this plugin neither downloads nor bundles a pi runtime.`, { cause });
		this.name = "PiMissingError";
	}
};
/** The child process exited before an outstanding command answered. */
var PiExitedError = class extends Error {
	constructor(detail) {
		super(`pi-agent: the pi child exited before answering (${detail})`);
		this.name = "PiExitedError";
	}
};
/** Split one stdout stream into LF-terminated records without recognizing Unicode line separators. */
var LineReader = class {
	buffer = "";
	decoder = new TextDecoder("utf-8");
	/** Feed one chunk; @returns complete LF-terminated lines. */
	push(chunk) {
		this.buffer += this.decoder.decode(chunk, { stream: true });
		const lines = [];
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			if (line !== "") lines.push(line);
			index = this.buffer.indexOf("\n");
		}
		return lines;
	}
	/** Flush a trailing record without terminator, if any. */
	flush() {
		const rest = this.buffer + this.decoder.decode();
		this.buffer = "";
		return rest === "" ? [] : [rest];
	}
};
function classify(record) {
	if (record.type === "response" && typeof record.command === "string") return "response";
	if (typeof record.type === "string" && record.type !== "response") return "session-event";
	return "other";
}
/** One live pi child process speaking the pi RPC protocol. */
var PiRpcChild = class PiRpcChild {
	process;
	pending = /* @__PURE__ */ new Map();
	lineReader = new LineReader();
	settleWaiters = [];
	exitWaiters = [];
	stderrTail = "";
	exited = false;
	exitDetail = "unknown exit";
	fatalError;
	runsStarted = 0;
	runsSettled = 0;
	optimisticStart = false;
	_sessionFile;
	_sessionId;
	disposed = false;
	constructor(process, command) {
		this.process = process;
		process.stdout?.on("data", (chunk) => {
			this.consume(chunk);
		});
		process.stderr?.on("data", (chunk) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2e3);
		});
		process.on("error", (error) => {
			const translated = error.code === "ENOENT" ? new PiMissingError(command, error) : error;
			this.fatalError = translated;
			this.failPending(translated);
			this.markExited(error.message);
		});
		process.on("exit", (code, signal) => {
			this.failPending(new PiExitedError(this.exitDetail));
			this.markExited(`exit ${String(code ?? signal ?? "?")}`);
		});
	}
	/** Spawn one pi child; pending commands reject with {@link PiMissingError} when the executable is absent. */
	static start(options) {
		const argv = [
			...options.args,
			"--mode",
			"rpc",
			"--session-dir",
			options.sessionDir,
			...options.sessionFile !== void 0 ? ["--session", options.sessionFile] : [],
			...options.tools !== void 0 ? ["--tools", options.tools] : [],
			...options.provider !== void 0 ? ["--provider", options.provider] : [],
			...options.model !== void 0 ? ["--model", options.model] : []
		];
		return new PiRpcChild(spawn(options.command, argv, {
			cwd: options.cwd,
			env: {
				...process.env,
				...options.env
			},
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		}), options.command);
	}
	/** The concrete session file pi reported, once known. */
	get sessionFile() {
		return this._sessionFile;
	}
	/** The session id pi reported, once known. */
	get sessionId() {
		return this._sessionId;
	}
	/** Host-side process id of the spawned child, or undefined after exit. */
	get pid() {
		return this.process.pid;
	}
	/** Whether a run is currently streaming. */
	get isStreaming() {
		return this.runsStarted > this.runsSettled;
	}
	/** Whether the process has exited. */
	get hasExited() {
		return this.exited;
	}
	/** Complete the RPC handshake; resolves with the child's session state. */
	async ready() {
		const state = await this.command("get_state");
		this._sessionFile = state.sessionFile;
		this._sessionId = state.sessionId;
		this.calibrate(state.isStreaming);
		return state;
	}
	/** Send one user message; a streaming child queues it as a follow-up. */
	async sendPrompt(text) {
		const data = await this.sendPromptOnce(text);
		if (data.disposition === "started" && !this.isStreaming && !this.optimisticStart) {
			this.optimisticStart = true;
			this.runsStarted += 1;
		}
		return data.disposition ?? "accepted";
	}
	/** One prompt attempt; a freshly started pi can reject the very first prompt while its extensions load, so retry once. */
	async sendPromptOnce(text) {
		try {
			return await this.command("prompt", {
				message: text,
				...this.isStreaming ? { streamingBehavior: "followUp" } : {}
			});
		} catch (error) {
			if (this.exited) throw error;
			await new Promise((resolve) => {
				setTimeout(resolve, 400);
			});
			return await this.command("prompt", {
				message: text,
				streamingBehavior: "followUp"
			});
		}
	}
	/** Drop queued messages and abort the current run; bounds the idle wait. */
	async interrupt() {
		await this.command("clear_queue");
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(/* @__PURE__ */ new Error("pi-agent: abort did not settle within the bounded wait"));
			}, ABORT_WAIT_MS);
			timer.unref();
			this.command("abort").then(() => {
				clearTimeout(timer);
				resolve();
			}, (error) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
		this.calibrate(false);
	}
	/** Current session state from the child. */
	async state() {
		const state = await this.command("get_state");
		this.calibrate(state.isStreaming);
		return state;
	}
	/** Align run counters with one authoritative streaming answer. */
	calibrate(streaming) {
		this.optimisticStart = false;
		this.runsStarted = streaming ? 1 : 0;
		this.runsSettled = 0;
	}
	/** Apply one thinking level for this child's runs. */
	async setThinking(level) {
		await this.command("set_thinking_level", { level });
	}
	/** List the pi-side models this child can select. */
	async availableModels() {
		return (await this.command("get_available_models")).models ?? [];
	}
	/** Last assistant text, bounded; `undefined` before any answer. */
	async lastAssistantText() {
		const data = await this.command("get_last_assistant_text");
		const text = data.text === null ? void 0 : data.text;
		return text === void 0 ? void 0 : text.slice(0, MAX_RESULT_CHARS);
	}
	/** Settle-poll interval while waiting on events; the authoritative state query self-heals a lost event. */
	static SETTLE_POLL_MS = 2e3;
	/** Resolve when the current run settles, or immediately when idle or exited. */
	async waitSettled() {
		while (!this.exited && this.isStreaming) {
			await Promise.race([new Promise((resolve) => {
				this.settleWaiters.push(resolve);
			}), new Promise((resolve) => {
				setTimeout(resolve, PiRpcChild.SETTLE_POLL_MS).unref();
			})]);
			try {
				await this.state();
			} catch {
				break;
			}
		}
	}
	/** Resolve once the process exits, however it exits. */
	async waitExit() {
		if (this.exited) return;
		await new Promise((resolve) => {
			this.exitWaiters.push(resolve);
		});
	}
	/** Terminate the child: graceful request, then forceful kill after the grace bound. */
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		const exit = this.waitExit();
		const kill = () => {
			this.process.kill("SIGKILL");
		};
		const timer = setTimeout(kill, DISPOSE_GRACE_MS);
		timer.unref();
		try {
			this.process.kill("SIGTERM");
		} catch {}
		await exit;
		clearTimeout(timer);
	}
	command(type, payload = {}) {
		return new Promise((resolve, reject) => {
			if (this.exited) {
				reject(this.fatalError ?? new PiExitedError(this.exitDetail));
				return;
			}
			const id = randomUUID();
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(/* @__PURE__ */ new Error(`pi-agent: RPC "${type}" received no response within ${String(COMMAND_TIMEOUT_MS)}ms`));
			}, COMMAND_TIMEOUT_MS);
			timer.unref();
			const settle = () => {
				clearTimeout(timer);
			};
			this.pending.set(id, {
				resolve: (data) => {
					settle();
					resolve(data);
				},
				reject: (error) => {
					settle();
					reject(error);
				}
			});
			this.process.stdin?.write(`${JSON.stringify({
				id,
				type,
				...payload
			})}\n`, (error) => {
				if (error !== void 0 && error !== null) {
					this.pending.delete(id);
					settle();
					reject(new PiExitedError(this.exitDetail));
				}
			});
		});
	}
	consume(chunk) {
		for (const line of this.lineReader.push(chunk)) {
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			this.dispatch(record);
		}
	}
	dispatch(record) {
		const kind = classify(record);
		if (kind === "response") {
			if (typeof record.id !== "string") return;
			const waiter = this.pending.get(record.id);
			if (waiter === void 0) return;
			this.pending.delete(record.id);
			if (record.success === true) waiter.resolve(record.data ?? {});
			else waiter.reject(/* @__PURE__ */ new Error(`pi RPC ${String(record.command)} failed: ${record.error?.message ?? "unknown error"}`));
			return;
		}
		if (kind === "session-event") {
			if (record.type === "agent_start") if (this.optimisticStart) this.optimisticStart = false;
			else this.runsStarted += 1;
			else if (record.type === "agent_settled") {
				if (this.runsSettled < this.runsStarted) this.runsSettled += 1;
				const waiters = this.settleWaiters.splice(0);
				for (const waiter of waiters) waiter();
			}
		}
	}
	failPending(error) {
		const waiters = [...this.pending.values()];
		this.pending.clear();
		for (const waiter of waiters) waiter.reject(error);
	}
	markExited(detail) {
		if (this.exited) return;
		this.exitDetail = detail;
		this.exited = true;
		this.runsSettled = this.runsStarted;
		for (const line of this.lineReader.flush()) try {
			this.dispatch(JSON.parse(line));
		} catch {}
		const settleWaiters = this.settleWaiters.splice(0);
		for (const waiter of settleWaiters) waiter();
		const exitWaiters = this.exitWaiters.splice(0);
		for (const waiter of exitWaiters) waiter();
	}
};
//#endregion
//#region src/manager.ts
/**
* Live child-process bookkeeping shared by the anonymous `pi_agent` tool and
* the digital-employee adapter. Anonymous children persist into the pointer
* registry; employee children hang off their employee records alone.
* @module pi-manager
*/
/** Live child processes keyed by their owning id (anonymous childId or employee id). */
var PiChildManager = class {
	registry;
	spawnOptions;
	children = /* @__PURE__ */ new Map();
	constructor(registry, spawnOptions) {
		this.registry = registry;
		this.spawnOptions = spawnOptions;
	}
	/** Live children that have not exited. */
	liveCount() {
		let count = 0;
		for (const child of this.children.values()) if (!child.hasExited) count += 1;
		return count;
	}
	/** The live child for one id, or undefined when absent or exited. */
	live(id) {
		const child = this.children.get(id);
		return child === void 0 || child.hasExited ? void 0 : child;
	}
	/** Start a new anonymous child, persist its record, and deliver the first task. */
	async create(cwd, task) {
		const child = PiRpcChild.start({
			...this.spawnOptions,
			cwd
		});
		const ready = await child.ready();
		if (ready.sessionFile === void 0) throw new Error("pi-agent: the pi child did not report a session file");
		const record = await this.registry.create({
			sessionFile: ready.sessionFile,
			...ready.sessionId !== void 0 ? { sessionId: ready.sessionId } : {},
			cwd,
			...child.pid !== void 0 ? { pid: child.pid } : {}
		});
		this.children.set(record.id, child);
		this.watchExit(record.id, child);
		await child.sendPrompt(task);
		this.observeSettled(record.id, child);
		return { id: record.id };
	}
	/** Cold-resume one recorded anonymous child from its pi session file. */
	async attach(id, sessionFile, cwd) {
		const child = PiRpcChild.start({
			...this.spawnOptions,
			cwd,
			sessionFile
		});
		this.children.set(id, child);
		this.watchExit(id, child);
		await child.ready();
		await this.registry.update(id, {
			state: "running",
			...child.pid !== void 0 ? { pid: child.pid } : {}
		});
		return child;
	}
	/**
	* Ensure the employee's pi child is live: reuse it, cold-resume the bound
	* session file, or start a fresh one. Employee children never touch the
	* anonymous pointer registry.
	* @returns the live child and whether this call created a fresh pi session.
	*/
	async ensureForEmployee(employee) {
		const existing = this.live(employee.id);
		if (existing !== void 0) return {
			child: existing,
			createdFresh: false
		};
		const createdFresh = employee.piSessionFile === void 0;
		const employeeModel = employee.piModel;
		const child = PiRpcChild.start({
			...this.spawnOptions,
			cwd: employee.cwd,
			...employeeModel !== void 0 ? {
				provider: employeeModel.provider,
				model: employeeModel.modelId
			} : {},
			...!createdFresh ? { sessionFile: employee.piSessionFile } : {}
		});
		this.children.set(employee.id, child);
		this.watchExit(employee.id, child);
		await child.ready();
		if (employee.thinking !== void 0) await child.setThinking(employee.thinking);
		return {
			child,
			createdFresh
		};
	}
	/** Record the bounded last answer once the current run settles. */
	observeSettled(id, child) {
		(async () => {
			try {
				await child.waitSettled();
				const text = await child.lastAssistantText();
				await this.registry.update(id, { lastResult: text ?? "" });
			} catch {}
		})();
	}
	/** Terminate every live child; used on plugin unload and Host exit. */
	async disposeAll() {
		const exits = [];
		for (const child of this.children.values()) if (!child.hasExited) exits.push(child.dispose());
		await Promise.allSettled(exits);
		this.children.clear();
	}
	watchExit(id, child) {
		child.waitExit().then(() => {
			if (this.registry.get(id) === void 0) return;
			this.registry.update(id, { state: "inactive" }).catch(() => void 0);
		});
	}
};
//#endregion
//#region src/employee-store.ts
/**
* Durable employee directory: one record per user-created digital employee
* (name, description, working directory, optional imported pi session file,
* and the bound dsh session id). Stored beside the child registry under the
* Harness home so backup, cleanup, and uninstall follow it.
* @module pi-employee-store
*/
/** Employee type ids and their presets. */
const EMPLOYEE_TYPES = { "pi-coder": {
	label: "数字程序员",
	description: "你是数字程序员，负责编码任务。收到消息后按要求完成任务并简要汇报。",
	emoji: "🧑‍💻"
} };
/** Load and persist the employee directory; malformed files fail loudly. */
var EmployeeStore = class EmployeeStore {
	file;
	records = /* @__PURE__ */ new Map();
	constructor(file) {
		this.file = file;
	}
	/** Load the directory; a missing file starts empty, a malformed file fails loudly. */
	static load(file) {
		const store = new EmployeeStore(file);
		if (!existsSync(file)) return store;
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(parsed)) throw new Error(`pi-agent: employee directory ${file} is malformed (expected an array)`);
		for (const entry of parsed) {
			const record = entry;
			if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.description !== "string" || typeof record.cwd !== "string") throw new Error(`pi-agent: employee directory ${file} is malformed (an employee record misses required fields)`);
			store.records.set(record.id, {
				...record,
				type: "pi-coder",
				avatar: record.avatar ?? EMPLOYEE_TYPES["pi-coder"].emoji
			});
		}
		return store;
	}
	/** All records in creation order. */
	list() {
		return [...this.records.values()];
	}
	/** One record by id. */
	get(id) {
		return this.records.get(id);
	}
	/** Resolve one record by its bound dsh session id. */
	bySession(sessionId) {
		return this.list().find((employee) => employee.sessionId === sessionId);
	}
	/** Validate input and persist one new employee. */
	async create(input) {
		const type = input.type ?? "pi-coder";
		const preset = EMPLOYEE_TYPES[type];
		const name = input.name === void 0 || input.name.trim().length === 0 ? this.defaultName(type) : input.name.trim();
		const description = input.description === void 0 || input.description.trim().length === 0 ? preset.description : input.description;
		if (!isDirectory(input.cwd)) throw new Error(`pi-agent: employee cwd is not an existing directory: ${input.cwd}`);
		if (input.piSessionFile !== void 0 && !existsSync(input.piSessionFile)) throw new Error(`pi-agent: imported pi session file does not exist: ${input.piSessionFile}`);
		if (this.list().some((employee) => employee.name === name)) throw new Error(`pi-agent: an employee named "${name}" already exists`);
		const record = {
			id: randomUUID().slice(0, 8),
			type,
			name,
			avatar: input.avatar === void 0 || input.avatar.trim().length === 0 ? preset.emoji : input.avatar,
			description,
			cwd: input.cwd,
			...input.piModel !== void 0 ? { piModel: input.piModel } : {},
			...input.thinking !== void 0 ? { thinking: input.thinking } : {},
			...input.piSessionFile !== void 0 ? { piSessionFile: input.piSessionFile } : {},
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		this.records.set(record.id, record);
		await this.save();
		return record;
	}
	/** Next "数字程序员 N"-style default name for one type. */
	defaultName(type) {
		const label = EMPLOYEE_TYPES[type].label;
		let index = 1;
		const taken = new Set(this.list().map((employee) => employee.name));
		while (taken.has(`${label} ${index}`)) index += 1;
		return `${label} ${index}`;
	}
	/** Patch and persist one employee. */
	async update(id, patch) {
		const current = this.records.get(id);
		if (current === void 0) throw new Error(`pi-agent: unknown employee ${id}`);
		if (patch.cwd !== void 0 && !isDirectory(patch.cwd)) throw new Error(`pi-agent: employee cwd is not an existing directory: ${patch.cwd}`);
		if (patch.name !== void 0 && this.list().some((employee) => employee.id !== id && employee.name === patch.name)) throw new Error(`pi-agent: an employee named "${patch.name}" already exists`);
		if (patch.piSessionFile !== void 0 && !existsSync(patch.piSessionFile)) throw new Error(`pi-agent: imported pi session file does not exist: ${patch.piSessionFile}`);
		const next = {
			...current,
			...patch
		};
		this.records.set(id, next);
		await this.save();
		return next;
	}
	/**
	* Record the pi session file our own child just reported. Unlike an import,
	* the file is authoritative from the child's `get_state`, so no existence
	* check races the child's own flush.
	*/
	async bindSessionFile(id, piSessionFile) {
		const current = this.records.get(id);
		if (current === void 0) throw new Error(`pi-agent: unknown employee ${id}`);
		if (current.piSessionFile === piSessionFile) return;
		this.records.set(id, {
			...current,
			piSessionFile
		});
		await this.save();
	}
	/** Remove and persist one employee. */
	async delete(id) {
		if (!this.records.has(id)) throw new Error(`pi-agent: unknown employee ${id}`);
		this.records.delete(id);
		await this.save();
	}
	async save() {
		await writeFileAtomic(this.file, `${JSON.stringify([...this.records.values()], void 0, 2)}\n`, {
			mode: 384,
			dirMode: 448
		});
	}
};
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
//#endregion
//#region src/employee-adapter.ts
/**
* The pi digital-employee LLM adapter: one provider route whose "model" is
* the employee id. Each stream call forwards the last user message to that
* employee's pi child (injecting the responsibility description into a fresh
* pi session) and streams the settled pi answer back, so the complete dsh
* session lifecycle — messages, history, interruption — is reused verbatim.
* @module pi-employee-adapter
*/
/** Provider route every employee session selects. */
const PI_EMPLOYEE_PROVIDER = "pi-employee";
/** The pi-as-model adapter for digital-employee sessions. */
var PiEmployeeAdapter = class extends LlmAdapter {
	deps;
	constructor(deps) {
		super();
		this.deps = deps;
	}
	resolveModel(provider, model) {
		return Promise.resolve({
			provider,
			id: model,
			name: `Digital employee ${model}`,
			context: {
				contextWindow: 2e5,
				maxTokens: 32768
			},
			defaultMaxTokens: 8192
		});
	}
	async *stream(options) {
		const employee = this.deps.employeeOf(options.model);
		if (employee === void 0) throw new Error(`pi-employee: unknown employee "${options.model}"`);
		const text = lastUserText(options);
		if (text.trim().length === 0) throw new Error("pi-employee: the request carries no user text to forward");
		const { child, createdFresh } = await this.deps.ensureChild(employee);
		if (createdFresh) await child.sendPrompt(employee.description);
		await child.sendPrompt(text);
		const onAbort = () => {
			child.interrupt().catch(() => void 0);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await child.waitSettled();
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
		const answer = (await child.lastAssistantText())?.slice(0, 32768) ?? "";
		yield {
			type: "block-start",
			index: 0,
			blockType: "text"
		};
		yield {
			type: "text-delta",
			index: 0,
			text: answer
		};
		yield {
			type: "block-end",
			index: 0,
			block: {
				type: "text",
				text: answer
			}
		};
		yield {
			type: "usage",
			usage: {
				inputTokens: 0,
				outputTokens: 0
			}
		};
		yield {
			type: "finish",
			reason: { kind: "stop" }
		};
	}
};
function lastUserText(options) {
	for (let index = options.messages.length - 1; index >= 0; index -= 1) {
		const message = options.messages[index];
		if (message?.role !== "user") continue;
		if (message.source?.kind === "runtime-context") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) continue;
		return content.filter((block) => typeof block === "object" && block !== null && block.type === "text").map((block) => block.text).join("");
	}
	return "";
}
//#endregion
//#region src/employee-directory.ts
/**
* The digital-employee directory service: employee CRUD over the durable
* store, plus the creation orchestration that gives every employee a dsh
* session inside the "我的数字员工" Workspace group bound to the pi-employee
* adapter route. Exposed to clients through the Typert gateway.
* @module pi-employee-directory
*/
/** Employee CRUD and session orchestration over the Typert gateway. */
var EmployeeDirectoryService = class extends TypertRemoteService {
	deps;
	groupTitle;
	workspace;
	modelsPromise;
	constructor(ctx, deps, groupTitle) {
		super(ctx, "employee");
		this.deps = deps;
		this.groupTitle = groupTitle;
	}
	/** Every employee in creation order. */
	@Remote("list") list() {
		return this.deps.store.list().map(employeeView);
	}
	/**
	* Validate and persist one employee, then give it a session inside the
	* employee Workspace group bound to the pi-employee adapter route.
	*/
	@Remote("create") async create(request) {
		const employee = await this.deps.store.create(request);
		const workspace = await this.ensureWorkspace();
		const sessionId = SessionId(`session-${randomUUID()}`);
		const handle = await this.ctx.agents.create({
			sessionId,
			meta: { cwd: workspace.path },
			agentOptions: {
				provider: PI_EMPLOYEE_PROVIDER,
				model: employee.id
			}
		});
		await workspace.attachSession(sessionId);
		this.applySessionTitle(handle.agent.session, employee.name);
		return employeeView(await this.deps.store.update(employee.id, { sessionId }));
	}
	/**
	* List the pi-side models available to employees. The first call spawns a
	* short-lived pi child; the result is cached for the Host lifetime.
	*/
	@Remote("piModels") async piModels() {
		if (this.modelsPromise === void 0) this.modelsPromise = this.queryPiModels().catch((error) => {
			this.modelsPromise = void 0;
			throw error;
		});
		return this.modelsPromise;
	}
	/** Patch one employee; unknown ids reject. */
	@Remote("update") async update(request) {
		return employeeView(await this.deps.store.update(request.id, {
			...request.name !== void 0 ? { name: request.name } : {},
			...request.description !== void 0 ? { description: request.description } : {},
			...request.cwd !== void 0 ? { cwd: request.cwd } : {}
		}));
	}
	/** Remove one employee; its session and pi files stay untouched. */
	@Remote("delete") async delete(request) {
		await this.deps.disposeChild(request.id);
		await this.deps.store.delete(request.id);
		return { deleted: true };
	}
	/** Spawn one short-lived pi child and ask it for its selectable models. */
	async queryPiModels() {
		return { models: await this.deps.listPiModels() };
	}
	/**
	* Name the bound session after the employee so the sidebar row reads as the
	* employee, not the default first-turn title. Best effort: a deployment
	* without the title service (or a rejected name) keeps the default title.
	*/
	applySessionTitle(session, name) {
		const titles = this.ctx.get("sessionTitle");
		if (titles === void 0) {
			this.ctx.logger.warn("pi-agent: no sessionTitle service visible from the directory service");
			return;
		}
		try {
			titles.rename(session, name);
		} catch (error) {
			this.ctx.logger.debug(`pi-agent: session title for employee "${name}" kept default: ${String(error)}`);
		}
	}
	/** Resolve the employee group Workspace, creating it once. */
	async ensureWorkspace() {
		if (this.workspace !== void 0) return this.workspace;
		const path = dshHomePath("pi-agent", "workspace");
		await mkdir(path, { recursive: true });
		const workspace = await this.ctx.workspaceRegistry.create(path);
		if (workspace.title !== this.groupTitle) await workspace.setTitle(this.groupTitle);
		this.workspace = workspace;
		return workspace;
	}
};
function employeeView(record) {
	return {
		id: record.id,
		type: record.type,
		name: record.name,
		avatar: record.avatar,
		description: record.description,
		cwd: record.cwd,
		...record.piModel !== void 0 ? { piModel: record.piModel } : {},
		...record.thinking !== void 0 ? { thinking: record.thinking } : {},
		...record.piSessionFile !== void 0 ? { piSessionFile: record.piSessionFile } : {},
		...record.sessionId !== void 0 ? { sessionId: record.sessionId } : {},
		createdAt: record.createdAt
	};
}
//#endregion
//#region src/employee-command.ts
/**
* The `/new-employee` slash command: the wizard's command form. Parses the
* employee name plus `--cwd`, `--description`, and `--session` options from
* the raw input and delegates to the employee directory service.
* @module pi-employee-command
*/
/**
* Parse one `/new-employee` raw input: a quoted or bare name, then
* `--cwd`, `--description` (or `--desc`), and `--session` options whose
* values may be double-quoted.
* @param raw - text after the command name.
* @returns the parsed input, or an error message naming the violation.
*/
function parseNewEmployeeInput(raw) {
	const tokens = tokenize(raw);
	const first = tokens[0];
	if (first === void 0 || first.value.startsWith("--")) return { error: "usage: /new-employee <name> [--cwd <dir>] [--description <text>] [--session <file>]" };
	const name = first.value;
	const options = /* @__PURE__ */ new Map();
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token.value.startsWith("--")) continue;
		const key = token.value === "--desc" ? "--description" : token.value;
		const value = tokens.at(index + 1)?.value;
		if (value === void 0 || value.startsWith("--")) return { error: `option ${key} needs a value` };
		if (options.has(key)) return { error: `option ${key} was given twice` };
		options.set(key, value);
		index += 1;
	}
	const cwd = options.get("--cwd");
	if (cwd === void 0 || cwd.length === 0) return { error: "--cwd is required: the employee needs a working directory" };
	const description = options.get("--description");
	if (description === void 0 || description.trim().length === 0) return { error: "--description is required: the employee needs a responsibility description" };
	const session = options.get("--session");
	return {
		name,
		cwd,
		description,
		...session !== void 0 ? { piSessionFile: session } : {}
	};
}
function newEmployeeCommand(create) {
	return {
		definitionId: CommandDefinitionId("@deepseek-ai/dsh-pi-agent/new-employee"),
		name: "new-employee",
		description: "Create a digital employee (pi coding agent) in the 我的数字员工 group",
		recordInput: false,
		handler: async (invocation) => {
			const parsed = parseNewEmployeeInput(invocation.rawInput);
			if ("error" in parsed) return {
				kind: "error",
				text: parsed.error
			};
			try {
				const view = await create(parsed);
				return {
					kind: "success",
					text: `数字员工 “${view.name}” 已创建（${view.id}）。会话已加入“我的数字员工”分组；打开它直接对话，任务会由 pi 在 ${parsed.cwd} 中执行。`
				};
			} catch (error) {
				return {
					kind: "error",
					text: error instanceof Error ? error.message : String(error)
				};
			}
		}
	};
}
function tokenize(raw) {
	const tokens = [];
	let index = 0;
	while (index < raw.length) {
		while (index < raw.length && /\s/u.test(raw.charAt(index))) index += 1;
		if (index >= raw.length) break;
		if (raw[index] === "\"") {
			const end = raw.indexOf("\"", index + 1);
			if (end === -1) return [{
				value: raw.slice(index + 1),
				quoted: true
			}];
			tokens.push({
				value: raw.slice(index + 1, end),
				quoted: true
			});
			index = end + 1;
			continue;
		}
		const start = index;
		while (index < raw.length && !/\s/u.test(raw.charAt(index))) index += 1;
		tokens.push({
			value: raw.slice(start, index),
			quoted: false
		});
	}
	return tokens;
}
//#endregion
//#region src/index.ts
const name = "pi-agent";
const inject = [
	"tools",
	"workingDirectory",
	"systemPrompt",
	"llm",
	"agents",
	"workspaceRegistry"
];
/** Default ceiling on simultaneously live pi children per plugin instance. */
const DEFAULT_MAX_CHILDREN = 4;
/** Smallest meaningful child ceiling. */
const MIN_MAX_CHILDREN = 1;
/** Default executable started for every child. */
const DEFAULT_COMMAND = "pi";
/** Schemastery configuration for the pi agent tool consumer. */
const Config = z.object({
	command: z.string().default("pi"),
	args: z.array(z.string()).default([]),
	tools: z.string(),
	provider: z.string(),
	model: z.string(),
	env: z.dict(z.string()).default({}),
	maxChildren: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4),
	groupTitle: z.string().default("我的数字员工")
});
const CHILD_SUMMARY_PROPERTIES = {
	childId: {
		type: "string",
		required: true
	},
	state: {
		type: "string",
		required: true,
		enum: [
			"running",
			"idle",
			"inactive"
		]
	},
	cwd: {
		type: "string",
		required: true
	},
	sessionFile: {
		type: "string",
		required: true
	},
	lastResult: { type: "string" }
};
function summary(record, live) {
	const state = live === void 0 || live.hasExited ? "inactive" : live.isStreaming ? "running" : "idle";
	const lastResult = record.lastResult === void 0 || record.lastResult === "" ? void 0 : record.lastResult;
	return {
		childId: record.id,
		state,
		cwd: record.cwd,
		sessionFile: record.sessionFile,
		...lastResult !== void 0 ? { lastResult } : {}
	};
}
function summariesText(children) {
	if (children.length === 0) return "No pi children recorded.";
	return children.map((child) => {
		const answer = child.lastResult === void 0 ? "" : `\n  last result: ${child.lastResult.slice(0, 2e3)}`;
		return `- ${child.childId} — ${child.state} — ${child.cwd}${answer}`;
	}).join("\n");
}
function requireAgent(agent) {
	if (agent === void 0) throw new Error("pi_agent requires an initiating agent");
	return agent;
}
function requireChildId(args) {
	if (args.childId === void 0 || args.childId.length === 0) throw new Error("childId is required for this operation");
	return args.childId;
}
/** Validate configuration, prepare durable state, and register the `pi_agent` tool. */
async function apply(ctx, config = {}) {
	const command = config.command ?? "pi";
	if (command.length === 0) throw new Error("pi-agent: command must be a non-empty string");
	const maxChildren = config.maxChildren ?? 4;
	if (!Number.isSafeInteger(maxChildren) || maxChildren < 1) throw new Error(`pi-agent: maxChildren must be a safe integer of at least 1`);
	const paths = await ensurePiAgentDirs();
	const store = EmployeeStore.load(resolve(paths.root, "employees.json"));
	const registry = PiChildRegistry.load({
		file: paths.registryFile,
		sessionsDir: paths.sessions
	});
	await registry.sweepOrphans((line) => {
		ctx.logger.warn(line);
	});
	const spawnOptions = {
		command,
		args: config.args ?? [],
		sessionDir: paths.sessions,
		...config.tools !== void 0 ? { tools: config.tools } : {},
		...config.provider !== void 0 ? { provider: config.provider } : {},
		...config.model !== void 0 ? { model: config.model } : {},
		env: config.env ?? {}
	};
	const manager = new PiChildManager(registry, spawnOptions);
	ctx.effect(() => () => {
		manager.disposeAll();
	});
	const ensureInFlight = /* @__PURE__ */ new Map();
	const ensureChild = async (employee) => {
		const existing = manager.live(employee.id);
		if (existing !== void 0) return {
			child: existing,
			createdFresh: false
		};
		const inFlight = ensureInFlight.get(employee.id);
		if (inFlight !== void 0) return inFlight;
		const ensured = manager.ensureForEmployee(employee).then(async (result) => {
			if (result.createdFresh && result.child.sessionFile !== void 0) await store.bindSessionFile(employee.id, result.child.sessionFile);
			return result;
		});
		ensureInFlight.set(employee.id, ensured);
		try {
			return await ensured;
		} finally {
			ensureInFlight.delete(employee.id);
		}
	};
	ctx.llm.registerAdapter([PI_EMPLOYEE_PROVIDER], new PiEmployeeAdapter({
		employeeOf: (employeeId) => store.get(employeeId),
		ensureChild
	}));
	const directory = new EmployeeDirectoryService(ctx, {
		store,
		disposeChild: async (employeeId) => {
			const live = manager.live(employeeId);
			if (live !== void 0) await live.dispose();
		},
		listPiModels: async () => {
			const probe = PiRpcChild.start({
				...spawnOptions,
				cwd: paths.root
			});
			try {
				await probe.ready();
				return (await probe.availableModels()).map((model) => ({
					provider: model.provider,
					modelId: model.id,
					name: model.name
				}));
			} finally {
				await probe.dispose().catch(() => void 0);
			}
		}
	}, config.groupTitle ?? "我的数字员工");
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.effect(function* () {
			yield commandCtx.commands.register(newEmployeeCommand((input) => directory.create(input)));
		}, "pi-agent command lifecycle");
	});
	ctx.systemPrompt.section({
		name: "tool:pi-agent",
		order: ctx.systemPrompt.getSectionOrder("TOOL_PI_AGENT"),
		text: "Use pi_agent only when the operator explicitly asks for pi. This channel is separate from dsh subagents: pi children do not appear in list_agents and cannot receive subagent messages. start returns a childId immediately; poll status for the answer, send for follow-ups, interrupt to stop a running turn. Children survive Host restarts; an inactive child resumes on send."
	});
	ctx.tools.register(defineTool({
		name: "pi_agent",
		description: "Delegate a coding task to a pi coding-agent child and keep it continuable. This is a dedicated pi channel: pi children are not dsh subagents, do not appear in list_agents, and use pi's own session, model, and credentials. Use it only when the operator explicitly asks for pi.",
		parameters: {
			op: {
				type: "string",
				required: true,
				enum: [
					"start",
					"send",
					"interrupt",
					"status",
					"list"
				],
				description: "Operation: start, send, interrupt, status, or list."
			},
			task: {
				type: "string",
				description: "start: one self-contained task text for the new child."
			},
			message: {
				type: "string",
				description: "send: follow-up message for the child; an inactive child resumes from its pi session."
			},
			childId: {
				type: "string",
				description: "Target child id from start or list."
			},
			cwd: {
				type: "string",
				description: "start: working directory, relative to the Session current directory when not absolute (default: current directory)."
			}
		},
		output: {
			schema: { oneOf: [
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "started"
						},
						childId: {
							type: "string",
							required: true
						},
						state: {
							type: "string",
							required: true,
							const: "running"
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "sent"
						},
						childId: {
							type: "string",
							required: true
						},
						state: {
							type: "string",
							required: true,
							enum: ["running", "idle"]
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "interrupted"
						},
						childId: {
							type: "string",
							required: true
						},
						state: {
							type: "string",
							required: true,
							const: "idle"
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "status"
						},
						children: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: CHILD_SUMMARY_PROPERTIES
							}
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "list"
						},
						children: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: CHILD_SUMMARY_PROPERTIES
							}
						}
					}
				}
			] },
			render: (_args, value) => {
				if (value.kind === "started") return [{
					type: "text",
					text: `pi child ${value.childId} started and running; poll pi_agent status for the answer.`
				}];
				if (value.kind === "sent") return [{
					type: "text",
					text: `message delivered to pi child ${value.childId} (${value.state}); poll pi_agent status for the answer.`
				}];
				if (value.kind === "interrupted") return [{
					type: "text",
					text: `pi child ${value.childId} interrupted and idle.`
				}];
				return [{
					type: "text",
					text: `${value.kind === "status" ? "pi children status" : "pi children"}:\n${summariesText(value.children)}`
				}];
			}
		},
		presentCall: (args) => {
			return {
				card: "generic",
				title: args.op === "start" ? "Start pi child" : args.op === "send" ? `Message ${args.childId ?? "pi child"}` : args.op === "interrupt" ? `Interrupt ${args.childId ?? "pi child"}` : args.op === "status" ? `Status ${args.childId ?? "of pi children"}` : "List pi children",
				kind: "execute"
			};
		},
		async execute(args, exec) {
			exec.signal.throwIfAborted();
			if (args.op === "start") {
				if (args.task === void 0 || args.task.length === 0) throw new Error("start requires a non-empty task");
				if (manager.liveCount() >= maxChildren) throw new Error(`pi-agent: maxChildren (${String(maxChildren)}) live children reached; interrupt or wait for a child to finish`);
				const agent = requireAgent(exec.agent);
				const cwd = await ctx.workingDirectory.ensure(agent, exec.signal);
				const resolved = args.cwd === void 0 ? cwd : resolve(cwd, args.cwd);
				return {
					kind: "started",
					childId: (await manager.create(resolved, args.task)).id,
					state: "running"
				};
			}
			if (args.op === "send") {
				if (args.message === void 0 || args.message.length === 0) throw new Error("send requires a non-empty message");
				const childId = requireChildId(args);
				const record = registry.get(childId);
				if (record === void 0) throw new Error(`pi-agent: unknown child ${childId}`);
				const live = manager.live(childId) ?? await manager.attach(childId, record.sessionFile, record.cwd);
				await live.sendPrompt(args.message);
				manager.observeSettled(childId, live);
				return {
					kind: "sent",
					childId,
					state: live.isStreaming ? "running" : "idle"
				};
			}
			if (args.op === "interrupt") {
				const childId = requireChildId(args);
				const live = manager.live(childId);
				if (live === void 0) throw new Error(`pi-agent: child ${childId} is not running`);
				await live.interrupt();
				const text = await live.lastAssistantText();
				await registry.update(childId, { lastResult: text ?? "" });
				return {
					kind: "interrupted",
					childId,
					state: "idle"
				};
			}
			if (args.op === "status") {
				const childId = args.childId;
				const records = childId === void 0 ? registry.list() : registry.list().filter((record) => record.id === childId);
				if (childId !== void 0 && records.length === 0) throw new Error(`pi-agent: unknown child ${childId}`);
				return {
					kind: "status",
					children: await Promise.all(records.map(async (record) => {
						const live = manager.live(record.id);
						if (live === void 0) return summary(record, void 0);
						if (!live.isStreaming) {
							const text = await live.lastAssistantText().catch(() => void 0);
							if (text !== void 0 && record.lastResult !== text) await registry.update(record.id, { lastResult: text });
							return summary(registry.get(record.id) ?? record, live);
						}
						return summary(record, live);
					}))
				};
			}
			return {
				kind: "list",
				children: registry.list().map((record) => summary(record, manager.live(record.id)))
			};
		}
	}));
}
//#endregion
export { Config, DEFAULT_COMMAND, DEFAULT_MAX_CHILDREN, MIN_MAX_CHILDREN, apply, inject, name };
