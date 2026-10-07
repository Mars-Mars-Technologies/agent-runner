import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.js'
import type { ContainerSpec, RunningContainer } from './docker.js'
import { formatSdkMessage } from './format.js'
import type { BundleInspection, PreparedRepo } from './git.js'
import { pushRefspec, TaskError } from './git.js'
import type { GitHubPort } from './github.js'
import { detectGuardrailChanges } from './guardrails.js'
import { LogStream } from './logs.js'
import { buildPrBody, buildPrTitle, checksPassed } from './prBody.js'
import type { ClaimedTask, FinalStatus, JobResult, LogEntry, LogType, TaskResult, TaskStatus } from './types.js'

export const GUARDRAIL_LABEL = 'touches-guardrails'
const AUTH_PAUSE_MS = 15 * 60_000
const LOG_TYPES = new Set<LogType>(['system', 'assistant', 'tool', 'tool_result', 'result', 'runner', 'error'])

const API_ERRORS: Record<string, string> = {
  rate_limit: 'Claude API rate limit reached; resubmit the task later.',
  overloaded: 'Claude API was overloaded; resubmit the task later.',
  authentication_failed: 'Claude API rejected the API key (check ANTHROPIC_API_KEY on the runner).',
  billing_error: 'Claude API billing problem (credit balance or spend limit).',
}

export interface RunnerDeps {
  config: Config
  api: {
    appendLogs: (taskId: number, entries: LogEntry[]) => Promise<TaskStatus>
    updateResult: (taskId: number, result: TaskResult) => Promise<'ok' | 'conflict'>
  }
  github: GitHubPort
  git: {
    prepareRepo: (args: { githubRepo: string, token: string, workDir: string, baseBranch: string, branchName: string }) => Promise<PreparedRepo>
    inspectBundle: (args: { workDir: string, baseSha: string, branchName: string }) => Promise<BundleInspection>
    pushBranch: (args: { workDir: string, githubRepo: string, branchName: string, taskId: number, baseBranch: string, token: string }) => Promise<void>
  }
  docker: {
    start: (spec: ContainerSpec, onStdout: (line: string) => void, onStderr: (line: string) => void) => RunningContainer
    remove: (name: string) => Promise<void>
  }
  redact: (text: string) => string
  log: (message: string) => void
  uid: number
  gid: number
  /** Override log batching intervals (tests) */
  logOptions?: { flushMs: number, heartbeatMs: number }
}

export interface RunOutcome {
  status: FinalStatus | 'cancelled'
  /** Set after Claude API auth/billing errors: stop claiming tasks for this long */
  pauseMs?: number
}

/** Run one claimed task end to end. Never throws; always cleans up the container and workdir. */
export async function runTask(claimed: ClaimedTask, deps: RunnerDeps, signal?: AbortSignal): Promise<RunOutcome> {
  const { task, githubRepo } = claimed
  const { config } = deps
  const containerName = `agent-task-${task.id}-${randomBytes(3).toString('hex')}`
  let container: RunningContainer | undefined
  let cancelled = false
  let aborted = false
  let timedOut = false
  let timer: NodeJS.Timeout | undefined
  let workDir: string | undefined

  const logs = new LogStream(deps.api, task.id, deps.redact, (status) => {
    if (status === 'cancelled') {
      cancelled = true
      void container?.kill()
    }
  }, deps.logOptions)
  const onAbort = () => {
    aborted = true
    void container?.kill()
  }
  signal?.addEventListener('abort', onAbort)

  const isCancelled = async () => cancelled || (await logs.flush()) === 'cancelled'

  const finish = async (result: TaskResult, pauseMs?: number): Promise<RunOutcome> => {
    const clean: TaskResult = {
      ...result,
      summary: result.summary !== undefined ? deps.redact(result.summary) : undefined,
      error: result.error !== undefined ? deps.redact(result.error) : undefined,
    }
    logs.push(result.status === 'failed' ? 'error' : 'runner', `Task ${result.status}${clean.error ? `: ${clean.error}` : ''}`)
    await logs.flush()
    const outcome = await deps.api.updateResult(task.id, clean)
    if (outcome === 'conflict') {
      deps.log(`task ${task.id}: result not recorded (cancelled meanwhile)`)

      return { status: 'cancelled' }
    }

    return { status: result.status, pauseMs }
  }

  const onStdout = (line: string) => {
    let parsed: any
    try {
      parsed = JSON.parse(line)
    }
    catch {
      logs.push('system', line)

      return
    }
    if (parsed?.kind === 'sdk') {
      for (const entry of formatSdkMessage(parsed.message))
        logs.push(entry.type, entry.message)
    }
    else if (parsed?.kind === 'log') {
      logs.push(LOG_TYPES.has(parsed.type) ? parsed.type : 'system', String(parsed.message ?? ''))
    }
  }
  const stderrTail: string[] = []
  const onStderr = (line: string) => {
    stderrTail.push(line)
    if (stderrTail.length > 40)
      stderrTail.shift()
  }

  logs.start()
  try {
    // Fail fast on a branch we would refuse to push (pushBranch enforces the same rule again).
    pushRefspec({ branchName: task.branch_name, taskId: task.id, baseBranch: task.base_branch })
    workDir = await mkdtemp(join(config.workDir, `task-${task.id}-`))
    logs.push('runner', `Runner ${config.runnerId} picked up the task. Cloning ${githubRepo} (${task.base_branch}) into a fresh workspace.`)

    const prepared = await deps.git.prepareRepo({
      githubRepo,
      token: await deps.github.token(githubRepo, 'read'),
      workDir,
      baseBranch: task.base_branch,
      branchName: task.branch_name,
    })
    await mkdir(join(workDir, 'out'))
    await writeFile(join(workDir, 'task.json'), JSON.stringify({
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      baseBranch: task.base_branch,
      branchName: task.branch_name,
      kind: prepared.kind,
      hasBaseChecks: prepared.hasBaseChecks,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      model: config.model,
    }))

    if (await isCancelled())
      return { status: 'cancelled' }
    if (aborted)
      return await finish({ status: 'failed', error: 'The agent runner was stopped before this task started.' })

    logs.push('runner', `Starting job container ${containerName}. Read-only from ${task.base_branch}: ${prepared.guardPaths.join(', ') || 'none'}.`)
    container = deps.docker.start({
      name: containerName,
      image: config.jobImage,
      runnerId: config.runnerId,
      taskId: task.id,
      uid: deps.uid,
      gid: deps.gid,
      memory: config.containerMemory,
      memorySwap: config.containerMemorySwap,
      cpus: config.containerCpus,
      workDir,
      guardPaths: prepared.guardPaths,
      env: {
        ANTHROPIC_API_KEY: config.anthropicApiKey,
        GIT_AUTHOR_NAME: config.gitAuthorName,
        GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
        GIT_COMMITTER_NAME: config.gitAuthorName,
        GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
      },
    }, onStdout, onStderr)
    timer = setTimeout(() => {
      timedOut = true
      void container?.kill()
    }, config.taskTimeoutMs)

    const exitCode = await container.done
    clearTimeout(timer)

    if (await isCancelled()) {
      logs.push('runner', 'Task was cancelled: container stopped, nothing pushed.')

      return { status: 'cancelled' }
    }
    if (aborted)
      return await finish({ status: 'failed', error: 'The agent runner was stopped while this task was running.' })
    if (timedOut)
      return await finish({ status: 'failed', error: `Timed out after ${Math.round(config.taskTimeoutMs / 60_000)} minutes.` })

    const job = await readJobResult(workDir)
    if (!job) {
      return await finish({
        status: 'failed',
        error: `Job container exited with code ${exitCode} without a result.\n${stderrTail.join('\n')}`.trim(),
      })
    }

    const pauseMs = job.apiError === 'authentication_failed' || job.apiError === 'billing_error' ? AUTH_PAUSE_MS : undefined
    const apiError = job.apiError ? API_ERRORS[job.apiError] ?? `Claude API error: ${job.apiError}` : ''
    const usage = { summary: job.summary || undefined, cost_usd: job.costUsd ?? undefined, turns: job.turns ?? undefined }

    const inspection = await deps.git.inspectBundle({ workDir, baseSha: prepared.baseSha, branchName: task.branch_name })
    if (!inspection.descendsFromBase)
      return await finish({ status: 'failed', ...usage, error: 'The agent rewrote git history: its branch no longer contains the base commit.' }, pauseMs)
    if (inspection.commits === 0) {
      const reason = [apiError, ...job.errors, job.summary || 'The agent finished without committing any changes.'].filter(Boolean).join('\n\n')

      return await finish({ status: 'failed', ...usage, error: reason }, pauseMs)
    }

    const guardrailChanges = detectGuardrailChanges(inspection.changedFiles, inspection.manifests)
    const passed = checksPassed(job)

    // Last cancellation check before anything becomes visible on GitHub.
    if (await isCancelled()) {
      logs.push('runner', 'Task was cancelled before the push; nothing pushed.')

      return { status: 'cancelled' }
    }

    logs.push('runner', `Pushing ${inspection.commits} commit(s) to ${task.branch_name}.`)
    const writeToken = await deps.github.token(githubRepo, 'write')
    await deps.git.pushBranch({ workDir, githubRepo, branchName: task.branch_name, taskId: task.id, baseBranch: task.base_branch, token: writeToken })

    const pr = await deps.github.openPullRequest({
      githubRepo,
      title: buildPrTitle(task, true),
      fallbackTitle: buildPrTitle(task, passed),
      body: deps.redact(buildPrBody({ task, feUrl: config.feUrl, job, guardrailChanges })),
      head: task.branch_name,
      base: task.base_branch,
      draft: !passed,
    }, writeToken)
    if (guardrailChanges.length) {
      logs.push('runner', `Guardrail files changed: ${guardrailChanges.join(', ')}. Adding label ${GUARDRAIL_LABEL}.`)
      await deps.github.addLabels(githubRepo, pr.number, [GUARDRAIL_LABEL], writeToken)
    }
    logs.push('runner', `Opened ${pr.draft ? 'draft ' : ''}PR #${pr.number}: ${pr.url}`)

    return await finish({
      status: passed ? 'pr_opened' : 'checks_failed',
      ...usage,
      pr_url: pr.url,
      pr_number: pr.number,
      error: passed ? undefined : [apiError, `Final checks ${job.checks.ran ? 'failed' : 'were not run'}; see the PR for details.`].filter(Boolean).join('\n'),
    }, pauseMs)
  }
  catch (error: any) {
    clearTimeout(timer)
    if (cancelled)
      return { status: 'cancelled' }
    const message = error instanceof TaskError ? error.message : `Runner error: ${error?.message ?? String(error)}`
    deps.log(`task ${task.id}: ${deps.redact(message)}`)
    try {
      return await finish({ status: 'failed', error: message })
    }
    catch (reportError: any) {
      deps.log(`task ${task.id}: could not report failure: ${deps.redact(reportError?.message ?? String(reportError))}`)

      return { status: 'failed' }
    }
  }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    await logs.stop().catch(() => {})
    if (container)
      await deps.docker.remove(containerName).catch(() => {})
    if (workDir)
      await rm(workDir, { recursive: true, force: true }).catch(error => deps.log(`task ${task.id}: cleanup failed: ${error.message}`))
  }
}

async function readJobResult(workDir: string): Promise<JobResult | null> {
  try {
    const job = JSON.parse(await readFile(join(workDir, 'out', 'result.json'), 'utf8')) as JobResult

    return {
      subtype: job.subtype ?? null,
      summary: job.summary ?? '',
      errors: Array.isArray(job.errors) ? job.errors.map(String) : [],
      costUsd: typeof job.costUsd === 'number' ? job.costUsd : null,
      turns: typeof job.turns === 'number' ? job.turns : null,
      commits: Number(job.commits) || 0,
      apiError: job.apiError ?? null,
      checks: {
        ran: Boolean(job.checks?.ran),
        passed: Boolean(job.checks?.passed),
        command: String(job.checks?.command ?? ''),
        output: String(job.checks?.output ?? ''),
      },
    }
  }
  catch {
    return null
  }
}
