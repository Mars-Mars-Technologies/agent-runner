import { existsSync } from 'node:fs'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import type { ContainerSpec } from '../src/docker.js'
import { TaskError } from '../src/git.js'
import { GitHubApp } from '../src/github.js'
import { LogStream } from '../src/logs.js'
import { makeRedactor } from '../src/redact.js'
import type { RunnerDeps } from '../src/runTask.js'
import { runTask } from '../src/runTask.js'
import type { ClaimedTask, JobResult, LogEntry, TaskStatus } from '../src/types.js'

const SECRET = 'sk-ant-test-secret-1234567890'

const claimed: ClaimedTask = {
  githubRepo: 'org/hms-api',
  task: {
    id: 7,
    repo: 'hms-api',
    title: 'Add a comment to README',
    prompt: 'Add a one-line comment at the top of README.md',
    base_branch: 'main',
    branch_name: 'claude/task-7-add-a-comment-to-readme',
    status: 'running',
  },
}

const okJob = (overrides: Partial<JobResult> = {}): JobResult => ({
  subtype: 'success',
  summary: 'Added the comment. Tests pass.',
  errors: [],
  costUsd: 0.5,
  turns: 8,
  commits: 1,
  apiError: null,
  checks: { ran: true, passed: true, command: 'php scripts/check.php --base=origin/main --tests', output: 'check: OK' },
  ...overrides,
})

interface Scenario {
  job?: JobResult | null
  commits?: number
  descendsFromBase?: boolean
  changedFiles?: string[]
  /** statuses returned by appendLogs, in order (last one repeats) */
  statuses?: TaskStatus[]
  /** container never exits by itself (only via kill) */
  hang?: boolean
  prepareError?: Error
}

async function setup(scenario: Scenario = {}) {
  const workRoot = await mkdtemp(join(tmpdir(), 'runner-test-'))
  const config: Config = {
    apiUrl: 'https://api.test/api',
    runnerToken: 'runner-token-123456',
    runnerId: 'runner-1',
    feUrl: 'https://hms.test',
    anthropicApiKey: SECRET,
    model: undefined,
    maxTurns: 60,
    maxBudgetUsd: 3,
    taskTimeoutMs: scenario.hang ? 200 : 60_000,
    github: { appId: '1', installationId: 2, privateKey: 'key' },
    gitAuthorName: 'HMS Agent',
    gitAuthorEmail: 'marsandmarstechnologies@gmail.com',
    maxConcurrent: 1,
    pollIntervalMs: 10,
    workDir: workRoot,
    jobImage: 'hms-agent-job:test',
    containerMemory: '1g',
    containerMemorySwap: '2g',
    containerCpus: '1',
  }

  const logs: LogEntry[] = []
  const statuses = [...(scenario.statuses ?? ['running'])]
  const kill = vi.fn()
  let started: ContainerSpec | undefined

  const deps: RunnerDeps = {
    config,
    api: {
      appendLogs: vi.fn(async (_id: number, entries: LogEntry[]) => {
        logs.push(...entries)

        return (statuses.length > 1 ? statuses.shift() : statuses[0]) as TaskStatus
      }),
      updateResult: vi.fn(async () => 'ok' as const),
    },
    github: {
      token: vi.fn(async (_repo: string, access: 'read' | 'write') => `${access}-token`),
      openPullRequest: vi.fn(async (args: { draft: boolean }) => ({ number: 12, url: 'https://github.com/org/hms-api/pull/12', draft: args.draft })),
      addLabels: vi.fn(async () => {}),
    },
    git: {
      prepareRepo: vi.fn(async () => {
        if (scenario.prepareError)
          throw scenario.prepareError

        return { baseSha: 'abc123', kind: 'php' as const, guardPaths: ['.claude', 'scripts/check.php'], hasBaseChecks: true }
      }),
      inspectBundle: vi.fn(async () => ({
        commits: scenario.commits ?? 1,
        descendsFromBase: scenario.descendsFromBase ?? true,
        changedFiles: scenario.changedFiles ?? ['README.md'],
        manifests: [],
      })),
      pushBranch: vi.fn(async () => {}),
    },
    docker: {
      start: vi.fn((spec: ContainerSpec, onStdout: (line: string) => void) => {
        started = spec
        let finish: (code: number) => void = () => {}
        const done = new Promise<number>((resolve) => {
          finish = resolve
        })
        onStdout(JSON.stringify({ kind: 'log', type: 'system', message: 'Installing dependencies' }))
        onStdout(JSON.stringify({ kind: 'sdk', message: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${SECRET}` } }] } } }))
        onStdout('not json output')
        if (!scenario.hang) {
          const job = scenario.job === undefined ? okJob() : scenario.job
          const write = job ? writeFile(join(spec.workDir, 'out', 'result.json'), JSON.stringify(job)) : Promise.resolve()
          void write.then(() => finish(0))
        }

        return { done, kill: kill.mockImplementation(async () => finish(137)) }
      }),
      remove: vi.fn(async () => {}),
    },
    redact: makeRedactor([SECRET, 'runner-token-123456']),
    log: vi.fn(),
    uid: 1000,
    gid: 1000,
    logOptions: { flushMs: 10, heartbeatMs: 10 },
  }

  return { deps, logs, kill, workRoot, started: () => started }
}

describe('runTask', () => {
  beforeEach(() => vi.useRealTimers())

  it('opens a ready PR when the agent committed and the base-branch checks passed', async () => {
    const { deps, logs, workRoot, started } = await setup()

    const outcome = await runTask(claimed, deps)

    expect(outcome).toEqual({ status: 'pr_opened', pauseMs: undefined })
    expect(deps.github.token).toHaveBeenNthCalledWith(1, 'org/hms-api', 'read')
    expect(deps.git.pushBranch).toHaveBeenCalledWith(expect.objectContaining({ token: 'write-token', branchName: claimed.task.branch_name }))
    expect(deps.github.openPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      draft: false,
      title: 'Add a comment to README',
      head: claimed.task.branch_name,
      base: 'main',
    }), 'write-token')
    expect(deps.github.addLabels).not.toHaveBeenCalled()
    expect(deps.api.updateResult).toHaveBeenCalledWith(7, expect.objectContaining({
      status: 'pr_opened',
      pr_number: 12,
      pr_url: 'https://github.com/org/hms-api/pull/12',
      cost_usd: 0.5,
      turns: 8,
    }))

    // container identity, git author/committer, cleanup
    expect(started()?.env).toMatchObject({ GIT_AUTHOR_NAME: 'HMS Agent', GIT_COMMITTER_EMAIL: 'marsandmarstechnologies@gmail.com' })
    expect(deps.docker.remove).toHaveBeenCalledWith(started()?.name)
    expect(await readdir(workRoot)).toEqual([])

    // logs streamed, secrets redacted
    expect(logs.some(l => l.message === 'Bash: echo [REDACTED]')).toBe(true)
    expect(JSON.stringify(logs)).not.toContain(SECRET)
  })

  it('opens a draft PR and reports checks_failed when the final checks fail', async () => {
    const { deps } = await setup({ job: okJob({ checks: { ran: true, passed: false, command: 'php scripts/check.php', output: 'FAIL' } }) })

    const outcome = await runTask(claimed, deps)

    expect(outcome.status).toBe('checks_failed')
    expect(deps.github.openPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      draft: true,
      fallbackTitle: '[checks failed] Add a comment to README',
    }), 'write-token')
    expect(deps.api.updateResult).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'checks_failed', pr_number: 12 }))
  })

  it('labels the PR and adds the warning section when guardrail files changed', async () => {
    const { deps } = await setup({ changedFiles: ['README.md', '.github/workflows/ci.yml'] })

    await runTask(claimed, deps)

    expect(deps.github.addLabels).toHaveBeenCalledWith('org/hms-api', 12, ['touches-guardrails'], 'write-token')
    const body = vi.mocked(deps.github.openPullRequest).mock.calls[0]![0].body
    expect(body).toContain('## ⚠️ Guardrail files changed')
    expect(body).toContain('.github/workflows/ci.yml')
  })

  it('fails with the agent explanation and pushes nothing when there are no commits', async () => {
    const { deps } = await setup({ commits: 0, job: okJob({ commits: 0, summary: 'README already has that comment; nothing to do.' }) })

    const outcome = await runTask(claimed, deps)

    expect(outcome.status).toBe('failed')
    expect(deps.git.pushBranch).not.toHaveBeenCalled()
    expect(deps.github.openPullRequest).not.toHaveBeenCalled()
    expect(deps.api.updateResult).toHaveBeenCalledWith(7, expect.objectContaining({
      status: 'failed',
      error: 'README already has that comment; nothing to do.',
    }))
  })

  it('refuses branches that rewrote history', async () => {
    const { deps } = await setup({ descendsFromBase: false })

    expect((await runTask(claimed, deps)).status).toBe('failed')
    expect(deps.git.pushBranch).not.toHaveBeenCalled()
    expect(vi.mocked(deps.api.updateResult).mock.calls[0]![1].error).toContain('rewrote git history')
  })

  it('kills the container on cancellation and never pushes or reports a result', async () => {
    const { deps, kill, workRoot } = await setup({ hang: true, statuses: ['running', 'cancelled'] })
    deps.config.taskTimeoutMs = 60_000

    const outcome = await runTask(claimed, deps)

    expect(outcome.status).toBe('cancelled')
    expect(kill).toHaveBeenCalled()
    expect(deps.git.pushBranch).not.toHaveBeenCalled()
    expect(deps.api.updateResult).not.toHaveBeenCalled()
    expect(deps.docker.remove).toHaveBeenCalled()
    expect(await readdir(workRoot)).toEqual([])
  })

  it('fails the task when it exceeds the timeout', async () => {
    const { deps, kill } = await setup({ hang: true })

    const outcome = await runTask(claimed, deps)

    expect(outcome.status).toBe('failed')
    expect(kill).toHaveBeenCalled()
    expect(deps.api.updateResult).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'failed', error: 'Timed out after 0 minutes.' }))
  })

  it('reports a missing base branch as a task failure', async () => {
    const { deps } = await setup({ prepareError: new TaskError('Base branch \'develop\' does not exist in org/hms-api') })

    expect((await runTask(claimed, deps)).status).toBe('failed')
    expect(deps.docker.start).not.toHaveBeenCalled()
    expect(deps.api.updateResult).toHaveBeenCalledWith(7, { status: 'failed', error: 'Base branch \'develop\' does not exist in org/hms-api', summary: undefined })
  })

  it('fails when the job produced no result and pauses after Claude auth errors', async () => {
    const noResult = await setup({ job: null })
    expect((await runTask(claimed, noResult.deps)).status).toBe('failed')
    expect(vi.mocked(noResult.deps.api.updateResult).mock.calls[0]![1].error).toContain('without a result')

    const auth = await setup({ commits: 0, job: okJob({ commits: 0, subtype: 'error_during_execution', summary: '', apiError: 'authentication_failed' }) })
    const outcome = await runTask(claimed, auth.deps)
    expect(outcome).toEqual({ status: 'failed', pauseMs: 15 * 60_000 })
    expect(vi.mocked(auth.deps.api.updateResult).mock.calls[0]![1].error).toContain('rejected the API key')
  })

  it('redacts secrets from reported summaries and errors', async () => {
    const { deps } = await setup({ commits: 0, job: okJob({ commits: 0, summary: `I printed ${SECRET} by mistake` }) })

    await runTask(claimed, deps)

    expect(JSON.stringify(vi.mocked(deps.api.updateResult).mock.calls)).not.toContain(SECRET)
  })

  it('cleans the workdir even when reporting fails', async () => {
    const { deps, workRoot } = await setup({ prepareError: new Error('network down') })
    vi.mocked(deps.api.updateResult).mockRejectedValue(new Error('API unreachable'))

    expect((await runTask(claimed, deps)).status).toBe('failed')
    expect(existsSync(workRoot)).toBe(true)
    expect(await readdir(workRoot)).toEqual([])
  })
})

describe('GitHubApp.openPullRequest', () => {
  const setupOctokit = (createImpl: (args: any) => Promise<any>) => {
    const create = vi.fn(createImpl)
    const app = new GitHubApp(
      { appId: '1', installationId: 2, privateKey: 'unused' },
      () => ({ rest: { pulls: { create }, issues: { addLabels: vi.fn() } } }) as any,
    )

    return { app, create }
  }
  const args = { githubRepo: 'org/hms-api', title: 'T', fallbackTitle: '[checks failed] T', body: 'b', head: 'claude/x', base: 'main', draft: true }

  it('falls back to a normal PR with the fallback title when drafts are not supported', async () => {
    const { app, create } = setupOctokit(async ({ draft }) => {
      if (draft)
        throw Object.assign(new Error('Draft pull requests are not supported in this repository.'), { status: 422 })

      return { data: { number: 5, html_url: 'https://github.com/org/hms-api/pull/5' } }
    })

    expect(await app.openPullRequest(args, 'tok')).toEqual({ number: 5, url: 'https://github.com/org/hms-api/pull/5', draft: false })
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ owner: 'org', repo: 'hms-api', title: '[checks failed] T', draft: false }))
  })

  it('rethrows other errors', async () => {
    const { app } = setupOctokit(async () => {
      throw Object.assign(new Error('A pull request already exists'), { status: 422 })
    })

    await expect(app.openPullRequest(args, 'tok')).rejects.toThrow('already exists')
  })
})

describe('LogStream', () => {
  it('reports status changes, keeps entries when the API is down, and drops batches rejected with 422', async () => {
    const onStatus = vi.fn()
    const appendLogs = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce('running')
      .mockRejectedValueOnce(Object.assign(new Error('invalid'), { status: 422 }))
      .mockResolvedValue('cancelled')
    const stream = new LogStream({ appendLogs }, 1, s => s, onStatus)

    stream.push('runner', 'first')
    expect(await stream.flush()).toBe('running') // API down: entry kept
    expect(await stream.flush()).toBe('running')
    expect(appendLogs).toHaveBeenLastCalledWith(1, [{ type: 'runner', message: 'first' }])

    stream.push('runner', 'bad')
    await stream.flush() // 422: dropped, not retried
    expect(await stream.flush()).toBe('cancelled')
    expect(appendLogs).toHaveBeenLastCalledWith(1, [])
    expect(onStatus).toHaveBeenCalledWith('cancelled')
  })
})
