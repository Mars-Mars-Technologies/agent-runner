import { readFileSync } from 'node:fs'

export interface Config {
  apiUrl: string
  runnerToken: string
  runnerId: string
  feUrl: string
  anthropicApiKey: string
  model: string | undefined
  maxTurns: number
  maxBudgetUsd: number
  taskTimeoutMs: number
  github: { appId: string, installationId: number, privateKey: string }
  gitAuthorName: string
  gitAuthorEmail: string
  maxConcurrent: number
  pollIntervalMs: number
  workDir: string
  jobImage: string
  containerMemory: string
  containerMemorySwap: string
  containerCpus: string
}

type Env = Record<string, string | undefined>

const required = (env: Env, name: string): string => {
  const value = env[name]?.trim()
  if (!value)
    throw new Error(`Missing required env var ${name}`)

  return value
}

const number = (env: Env, name: string, fallback: number): number => {
  const raw = env[name]?.trim()
  if (!raw)
    return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`Env var ${name} must be a positive number, got "${raw}"`)

  return value
}

export function loadConfig(env: Env = process.env, readFile = (p: string) => readFileSync(p, 'utf8')): Config {
  return {
    apiUrl: required(env, 'HMS_API_URL').replace(/\/+$/, ''),
    runnerToken: required(env, 'RUNNER_TOKEN'),
    runnerId: env.RUNNER_ID?.trim() || 'runner-1',
    feUrl: required(env, 'HMS_FE_URL').replace(/\/+$/, ''),
    anthropicApiKey: required(env, 'ANTHROPIC_API_KEY'),
    model: env.AGENT_MODEL?.trim() || undefined,
    maxTurns: number(env, 'MAX_TURNS', 60),
    maxBudgetUsd: number(env, 'MAX_BUDGET_USD', 3),
    taskTimeoutMs: number(env, 'TASK_TIMEOUT_MIN', 30) * 60_000,
    github: {
      appId: required(env, 'GITHUB_APP_ID'),
      installationId: number(env, 'GITHUB_APP_INSTALLATION_ID', 0),
      privateKey: readFile(required(env, 'GITHUB_APP_PRIVATE_KEY_PATH')),
    },
    gitAuthorName: env.GIT_AUTHOR_NAME?.trim() || 'HMS Agent',
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL?.trim() || 'marsandmarstechnologies@gmail.com',
    maxConcurrent: number(env, 'MAX_CONCURRENT', 1),
    pollIntervalMs: number(env, 'POLL_INTERVAL_SEC', 10) * 1000,
    workDir: env.WORK_DIR?.trim() || '/var/lib/agent-runner/work',
    jobImage: env.JOB_IMAGE?.trim() || 'hms-agent-job:latest',
    // Defaults sized for a 1 GB RAM + swap test server; raise them on bigger hosts.
    containerMemory: env.CONTAINER_MEMORY?.trim() || '900m',
    containerMemorySwap: env.CONTAINER_MEMORY_SWAP?.trim() || '3g',
    containerCpus: env.CONTAINER_CPUS?.trim() || '1',
  }
}

/** Values that must never appear in logs, PR bodies or error reports. */
export function secretValues(config: Config): string[] {
  return [config.runnerToken, config.anthropicApiKey, config.github.privateKey]
}
