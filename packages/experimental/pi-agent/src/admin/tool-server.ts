/**
 * The management tool server: an MCP streamable-HTTP endpoint on loopback that
 * exposes the five admin tools to a 数字管理员's pi child. The pi child loads it
 * through a project-local `.pi/mcp.json` in the employee group workspace; the
 * endpoint URL carries a random token path segment, so only processes holding
 * the file can reach it. Every binding and permission check lives in the
 * handlers (deterministic code) — the calling LLM cannot widen its powers.
 * @module pi-admin-tool-server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod'

/** The five admin tools an administrator's pi child may call. */
export interface AdminToolHandlers {
  /** Create a first-line employee bound to this admin. */
  createEmployee(args: { name: string; cwd: string }): Promise<{ id: string; name: string }>
  /** Destroy a bound employee; unbound targets are refused here. */
  destroyEmployee(args: { name: string }): Promise<{ destroyed: boolean; message: string }>
  /** List the bound employees with their running state. */
  listEmployees(): Promise<{ employees: ReadonlyArray<{ name: string; running: boolean }> }>
  /** Inject a task message into a bound employee's session. */
  dispatchTask(args: { employee: string; message: string }): Promise<{ dispatched: boolean; message: string }>
  /** Report one bound employee's intermediate state. */
  employeeStatus(args: { employee: string }): Promise<{ message: string }>
}

/** The endpoint URL format: loopback, ephemeral port, token path segment. */
export type ToolServerUrl = `http://127.0.0.1:${number}/mcp/${string}`

/** Input schemas of the five admin tools (parsed again inside each handler call). */

/**
 * One admin's tool server. Requests are served statelessly — each request
 * gets a fresh transport+server pair registered with the same five tools —
 * so there is no session state to lose across restarts.
 */
export class ManagementToolServer {
  private http: Server | undefined = undefined
  private url?: ToolServerUrl
  private readonly token = randomBytes(16).toString('hex')

  constructor(private readonly adminId: string, private readonly handlers: AdminToolHandlers) {}

  /** Bind the loopback listener; resolves with the endpoint URL for `.pi/mcp.json`. */
  async start(): Promise<ToolServerUrl> {
    await new Promise<void>((resolve, reject) => {
      this.http = createServer((req, res) => { void this.handle(req, res) })
      this.http.once('error', reject)
      this.http.listen(0, '127.0.0.1', resolve)
    })
    const address = this.http?.address()
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('pi-agent: admin tool server failed to bind')
    }
    this.url = `http://127.0.0.1:${address.port}/mcp/${this.token}`
    return this.url
  }

  /** The endpoint URL after {@link start}. */
  get endpoint(): ToolServerUrl {
    if (this.url === undefined) throw new Error('pi-agent: admin tool server is not started')
    return this.url
  }

  /** Stop the listener. In-flight requests are dropped. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http?.close((error) => {
        if (error !== undefined) reject(error)
        else resolve()
      })
      if (this.http === undefined) resolve()
    })
    this.http = undefined
  }

  /** Serve one request; a wrong token path answers 404 and drops the body. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== `/mcp/${this.token}`) {
      res.writeHead(404).end()
      return
    }
    const body = await this.readBody(req)
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      ...(body === undefined ? {} : { body }),
    } as RequestInit)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await this.connectOnce(transport)
    const response = await transport.handleRequest(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(await response.text())
  }

  /** Serve this request through a fresh stateless McpServer pair. */
  private async connectOnce(transport: WebStandardStreamableHTTPServerTransport): Promise<void> {
    const server = new McpServer({ name: 'digital-admin', version: '0.1.0' })
    const identityNote = `当前管理员 id: ${this.adminId}`
    server.registerTool('create_employee', {
      description: `创建一个数字程序员并绑定到本管理员（${identityNote}）。参数 name 为员工名，cwd 为其工作目录（必须已存在）。`,
      inputSchema: z.object({ name: z.string().describe('员工名'), cwd: z.string().describe('工作目录（已存在的绝对路径）') }),
    }, async ({ name, cwd }) => this.text(await this.handlers.createEmployee({ name, cwd })))
    server.registerTool('destroy_employee', {
      description: '销毁一个绑定到本管理员的数字员工（自动解绑）。只能销毁绑定关系内的员工。',
      inputSchema: z.object({ name: z.string().describe('员工名或 id') }),
    }, async ({ name }) => this.text(await this.handlers.destroyEmployee({ name })))
    server.registerTool('list_employees', {
      description: '列出绑定到本管理员的全部数字程序员及其运行状态。',
      inputSchema: z.object({}),
    }, async () => this.text(await this.handlers.listEmployees()))
    server.registerTool('dispatch_task', {
      description: '给指定数字程序员派任务：消息会注入该员工的会话，其完成后反馈会推送给用户。',
      inputSchema: z.object({ employee: z.string().describe('员工名'), message: z.string().describe('任务内容') }),
    }, async ({ employee, message }) => this.text(await this.handlers.dispatchTask({ employee, message })))
    server.registerTool('employee_status', {
      description: '查询指定数字程序员的中间状态：运行/空闲、最近反馈、最后活跃时间。',
      inputSchema: z.object({ employee: z.string().describe('员工名') }),
    }, async ({ employee }) => this.text(await this.handlers.employeeStatus({ employee })))
    await server.connect(transport)
  }

  /** Wrap a handler result as the MCP text content the LLM reads. */
  private text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
    return { content: [{ type: 'text', text: JSON.stringify(value, undefined, 2) }] }
  }

  private readBody(req: IncomingMessage, limit = 512 * 1024): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      if (req.method === 'GET') {
        resolve(undefined)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('pi-agent: admin tool server request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', reject)
    })
  }
}
