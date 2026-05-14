import type { CheckResult, ProductClientConfig, RouteMap, TestResult } from './types'

/**
 * ProductClient — configurable HTTP client for exercising any agent's APIs.
 *
 * Routes are config, not hardcoded. Each agent provides its own RouteMap.
 */
export class ProductClient {
  private baseUrl: string
  private routes: RouteMap
  private cookies: string = ''

  constructor(config: ProductClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.routes = config.routes
  }

  private route(name: keyof RouteMap): string {
    const path = this.routes[name]
    if (!path) throw new Error(`Route "${name}" not configured`)
    return path
  }

  async signup(name: string, email: string, password: string): Promise<{ userId: string }> {
    const res = await this.post(this.route('signup'), { name, email, password })
    const user = res.user as Record<string, unknown> | undefined
    if (!user?.id) throw new Error(`Signup failed: ${JSON.stringify(res)}`)
    return { userId: user.id as string }
  }

  async login(email: string, password: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${this.route('login')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: this.baseUrl },
      body: JSON.stringify({ email, password }),
      redirect: 'manual',
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) {
      this.cookies = setCookie.split(';')[0]
    }
    const body = (await res.json()) as Record<string, unknown>
    if (!body.user) throw new Error(`Login failed: ${JSON.stringify(body)}`)
  }

  async createWorkspace(name: string, type = 'project'): Promise<string> {
    const res = await this.post(this.route('workspaces'), { name, type })
    const ws = res.workspace as Record<string, unknown> | undefined
    if (!ws?.id) throw new Error(`Workspace creation failed: ${JSON.stringify(res)}`)
    return ws.id as string
  }

  async createThread(workspaceId: string): Promise<string> {
    const res = await this.post(this.route('threads'), { workspaceId })
    const thread = res.thread as Record<string, unknown> | undefined
    if (!thread?.id) throw new Error(`Thread creation failed: ${JSON.stringify(res)}`)
    return thread.id as string
  }

  async chat(
    workspaceId: string,
    threadId: string,
    content: string,
    _opts?: { blockPatterns?: RegExp[] },
  ): Promise<{ text: string; blocks: { type: string; title: string }[] }> {
    const res = await fetch(`${this.baseUrl}${this.route('chat')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: this.baseUrl,
        Cookie: this.cookies,
      },
      body: JSON.stringify({ workspaceId, threadId, content }),
    })

    if (!res.ok || !res.body) throw new Error(`Chat failed: ${res.status}`)

    // Parse NDJSON stream
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let text = ''
    const blocks: { type: string; title: string }[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as { type?: string; data?: { delta?: string } }
          if (event.type === 'message.part.updated' && event.data?.delta) {
            text += event.data.delta
          }
        } catch {
          /* skip non-JSON lines */
        }
      }
    }

    // Extract :::blocks from text
    const blockRe = /:::(\w+)\s*\n([\s\S]*?)\n\s*:::/g
    let match
    while ((match = blockRe.exec(text)) !== null) {
      const fields: Record<string, string> = {}
      for (const line of match[2].split('\n')) {
        const idx = line.indexOf(':')
        if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
      blocks.push({ type: match[1], title: fields.title ?? '' })
    }

    return { text, blocks }
  }

  async getTasks(
    workspaceId: string,
  ): Promise<{ id: string; title: string; status: string; priority: string }[]> {
    const res = await this.get(`${this.route('tasks')}?workspaceId=${workspaceId}`)
    return (res.tasks ?? []) as { id: string; title: string; status: string; priority: string }[]
  }

  async getEvents(workspaceId: string): Promise<{ id: string; title: string; type: string }[]> {
    const res = await this.get(`${this.route('events')}?workspaceId=${workspaceId}`)
    return (res.events ?? []) as { id: string; title: string; type: string }[]
  }

  async getApprovals(
    workspaceId: string,
  ): Promise<{ id: string; title: string; status: string; type: string }[]> {
    const res = await this.get(`${this.route('approvals')}?workspaceId=${workspaceId}`)
    return (res.actions ?? []) as { id: string; title: string; status: string; type: string }[]
  }

  async getVaultTree(workspaceId: string): Promise<string[]> {
    const res = await this.get(`${this.route('vault')}?workspaceId=${workspaceId}`)
    const paths: string[] = []
    function extract(nodes: unknown[]) {
      for (const n of nodes) {
        const node = n as { path?: string; type?: string; children?: unknown[] }
        if (node.type === 'file' && node.path) paths.push(node.path)
        if (node.children) extract(node.children)
      }
    }
    extract((res.tree ?? []) as unknown[])
    return paths
  }

  async approveAction(workspaceId: string, id: string): Promise<void> {
    await this.patch(this.route('approvals'), { workspaceId, id, status: 'approved' })
  }

  async rejectAction(workspaceId: string, id: string, reason: string): Promise<void> {
    await this.patch(this.route('approvals'), { workspaceId, id, status: 'rejected', reason })
  }

  async getGenerations(
    workspaceId: string,
  ): Promise<{ id: string; type: string; prompt: string }[]> {
    const res = await this.get(`${this.route('generations')}?workspaceId=${workspaceId}`)
    return (res.generations ?? []) as { id: string; type: string; prompt: string }[]
  }

  /** Generic GET for custom routes */
  async get(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Cookie: this.cookies },
    })
    return res.json() as Promise<Record<string, unknown>>
  }

  /** Generic POST for custom routes */
  async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: this.baseUrl,
        Cookie: this.cookies,
      },
      body: JSON.stringify(body),
    })
    return res.json() as Promise<Record<string, unknown>>
  }

  /** Generic PATCH for custom routes */
  async patch(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Origin: this.baseUrl,
        Cookie: this.cookies,
      },
      body: JSON.stringify(body),
    })
    return res.json() as Promise<Record<string, unknown>>
  }
}

/**
 * Run a full e2e workflow test against a live product.
 *
 * The `workflow` callback receives a ProductClient and returns CheckResults.
 * This is the generic harness — each agent defines its own workflow steps.
 */
export async function runE2EWorkflow(
  client: ProductClient,
  name: string,
  workflow: (client: ProductClient) => Promise<CheckResult[]>,
): Promise<TestResult> {
  const start = Date.now()
  const checks: CheckResult[] = []

  try {
    const results = await workflow(client)
    checks.push(...results)
  } catch (err) {
    checks.push({
      name: 'fatal_error',
      passed: false,
      expected: 'no crash',
      actual: err instanceof Error ? err.message : String(err),
    })
  }

  return {
    name,
    passed: checks.every((c) => c.passed),
    duration: Date.now() - start,
    detail: `${checks.filter((c) => c.passed).length}/${checks.length} checks passed`,
    checks,
  }
}
