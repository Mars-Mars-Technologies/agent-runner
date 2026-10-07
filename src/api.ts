import type { ClaimedTask, LogEntry, TaskResult, TaskStatus } from './types.js'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

type FetchFn = typeof fetch

/** Client for hms-api runner routes (/api/runner/agent-tasks/*), authenticated with the shared runner token. */
export class HmsApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly runnerId: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async request(method: string, path: string, body: Record<string, unknown>): Promise<{ status: number, json: any }> {
    const response = await this.fetchFn(`${this.baseUrl}/runner/agent-tasks${path}`, {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({ runner_id: this.runnerId, ...body }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    }
    catch {
      // non-JSON error page
    }

    return { status: response.status, json }
  }

  private fail(what: string, status: number, json: any): never {
    throw new ApiError(`${what} failed: HTTP ${status}${json?.message ? ` ${json.message}` : ''}`, status)
  }

  /** Atomically claim the oldest queued task; null when the queue is empty. */
  async claim(): Promise<ClaimedTask | null> {
    const { status, json } = await this.request('POST', '/claim', {})
    if (status === 204)
      return null
    if (status !== 200)
      this.fail('claim', status, json)

    return { task: json.data.agent_task, githubRepo: json.data.github_repo }
  }

  /** Append log entries (empty = heartbeat). Returns the task's current status, e.g. "cancelled". */
  async appendLogs(taskId: number, entries: LogEntry[]): Promise<TaskStatus> {
    const { status, json } = await this.request('POST', `/${taskId}/logs`, { entries })
    if (status !== 200)
      this.fail('append logs', status, json)

    return json.data.status
  }

  /** Report the final result. "conflict" when the task was cancelled (or is not ours) in the meantime. */
  async updateResult(taskId: number, result: TaskResult): Promise<'ok' | 'conflict'> {
    const { status, json } = await this.request('PATCH', `/${taskId}`, { ...result })
    if (status === 409)
      return 'conflict'
    if (status !== 200)
      this.fail('update result', status, json)

    return 'ok'
  }

  /** Fail this runner's tasks still marked running (call on startup). Returns how many were recovered. */
  async recover(): Promise<number> {
    const { status, json } = await this.request('POST', '/recover', {})
    if (status !== 200)
      this.fail('recover', status, json)

    return json.data.recovered
  }
}
