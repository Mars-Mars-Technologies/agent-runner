import type { AgentTask, JobResult } from './types.js'
import { tail, truncate } from './redact.js'

const MAX_PROMPT = 8000
const MAX_SUMMARY = 8000
const MAX_CHECK_OUTPUT = 6000

export interface PullRequestInput {
  task: AgentTask
  feUrl: string
  job: JobResult
  guardrailChanges: string[]
}

export function buildPrTitle(task: AgentTask, checksPassed: boolean): string {
  return truncate(`${checksPassed ? '' : '[checks failed] '}${task.title}`, 240)
}

export function checksPassed(job: JobResult): boolean {
  return job.checks.ran && job.checks.passed
}

/** PR description: original task, agent summary, check results, guardrail warning, link back to the task. */
export function buildPrBody({ task, feUrl, job, guardrailChanges }: PullRequestInput): string {
  const sections: string[] = []

  sections.push(`## Task\n[#${task.id} ${task.title}](${feUrl}/agent-tasks/${task.id}) · base \`${task.base_branch}\``)
  sections.push(`### Original request\n\n${fence(truncate(task.prompt, MAX_PROMPT))}`)
  sections.push(`## Agent summary\n\n${truncate(job.summary.trim() || '_The agent did not provide a summary._', MAX_SUMMARY)}`)

  if (!job.checks.ran) {
    sections.push(`## Checks\n\n⚠️ Not run: ${job.checks.output || 'the base branch has no scripts/check.* script.'}`)
  }
  else {
    const icon = job.checks.passed ? '✅ Passed' : '❌ Failed'
    sections.push(
      `## Checks\n\n${icon}: \`${job.checks.command}\` (base-branch version of the check script)\n\n`
      + `<details><summary>Output</summary>\n\n${fence(tail(job.checks.output, MAX_CHECK_OUTPUT))}\n</details>`,
    )
  }

  if (guardrailChanges.length) {
    sections.push(
      '## ⚠️ Guardrail files changed\n\n'
      + 'This PR changes files that control the agent\'s checks, git hooks or CI. Review them carefully:\n\n'
      + guardrailChanges.map(path => `- \`${path}\``).join('\n'),
    )
  }

  const cost = job.costUsd !== null ? `$${job.costUsd.toFixed(2)}` : 'n/a'
  sections.push(`---\nOpened by agent-runner · ${job.turns ?? '?'} turns · cost ${cost} · agent result: \`${job.subtype ?? 'n/a'}\``)

  return sections.join('\n\n')
}

/** Code fence that can't be closed early by backticks inside the text. */
function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(m => m.length))
  const ticks = '`'.repeat(longest + 1)

  return `${ticks}text\n${text}\n${ticks}`
}
