export type TaskStatus = 'queued' | 'running' | 'checks_failed' | 'pr_opened' | 'failed' | 'cancelled'

export type LogType = 'system' | 'assistant' | 'tool' | 'tool_result' | 'result' | 'runner' | 'error'

export interface LogEntry {
  type: LogType
  message: string
}

/** Subset of hms-api AgentTaskResource the runner uses. */
export interface AgentTask {
  id: number
  repo: string
  title: string
  prompt: string
  base_branch: string
  branch_name: string
  status: TaskStatus
}

export interface ClaimedTask {
  task: AgentTask
  /** GitHub "owner/name" */
  githubRepo: string
}

export type FinalStatus = 'pr_opened' | 'checks_failed' | 'failed'

export interface TaskResult {
  status: FinalStatus
  pr_url?: string
  pr_number?: number
  summary?: string
  error?: string
  cost_usd?: number
  turns?: number
}

/** Written by job/run-job.mjs to /work/out/result.json. */
export interface JobResult {
  /** SDK result subtype: success | error_max_turns | error_max_budget_usd | error_during_execution | null if the agent never ran */
  subtype: string | null
  summary: string
  errors: string[]
  costUsd: number | null
  turns: number | null
  commits: number
  /** Last SDKAssistantMessage.error seen, e.g. rate_limit, authentication_failed, billing_error */
  apiError: string | null
  checks: { ran: boolean, passed: boolean, command: string, output: string }
}

export type RepoKind = 'php' | 'node'
