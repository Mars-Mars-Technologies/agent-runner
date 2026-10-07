// Entry point of the job container (one per agent task). Trusted code: root-owned in the image.
// Input:  /work/task.json (written by the runner), /work/repo (fresh clone on the task branch).
// Output: JSON lines on stdout ({kind:"log"|"sdk"}) streamed to hms-api by the runner,
//         /work/out/result.json and, if the agent committed, /work/out/branch.bundle.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const REPO = '/work/repo'
const OUT = '/work/out'
const task = JSON.parse(readFileSync('/work/task.json', 'utf8'))

const emit = obj => process.stdout.write(`${JSON.stringify(obj)}\n`)
const log = (type, message) => emit({ kind: 'log', type, message })
const sh = (cmd, args) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const outputTail = (res, lines = 80) => `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}`.trim().split('\n').slice(-lines).join('\n')

const result = {
  subtype: null,
  summary: '',
  errors: [],
  costUsd: null,
  turns: null,
  commits: 0,
  apiError: null,
  checks: { ran: false, passed: false, command: '', output: '' },
}
const save = () => writeFileSync(`${OUT}/result.json`, JSON.stringify(result))

const INSTRUCTIONS = `
You are running unattended as an automated coding agent for the HMS team, inside a disposable container.
- The repository is ${REPO}, already checked out on branch "${task.branchName}" (created from "${task.baseBranch}"). Work only inside it.
- Follow CLAUDE.md and the project skills. Keep the change focused on the task.
- Commit your work on the current branch with Conventional Commit messages (type(scope): summary). Leave nothing uncommitted.
- Do not push, do not create or switch branches, do not rewrite history (no rebase/amend of existing commits, no reset of ${task.baseBranch}).
- .claude/, .githooks/ and scripts/check.* are read-only base-branch copies; do not try to change them. Changes to .github/ or to
  composer.json/package.json "scripts" are flagged for extra review.
- Nobody can answer questions during the run: make reasonable assumptions and state them in your summary.
- End with a short final message (it becomes the PR description): what changed, how you tested it (commands and results),
  assumptions, and anything that still fails.`

// 1. Dependencies, so hooks and tests work.
log('system', `Installing dependencies (${task.kind === 'php' ? 'composer install' : 'npm ci'})`)
const installs = task.kind === 'php'
  ? [['composer', ['install', '--no-interaction', '--no-progress', '--prefer-dist']]]
  : [['npm', ['ci', '--no-audit', '--no-fund']]]
for (const [cmd, args] of installs) {
  const res = sh(cmd, args)
  if (res.status !== 0) {
    result.errors.push(`Dependency install failed (${cmd} ${args[0]}):\n${outputTail(res, 40)}`)
    save()
    log('error', result.errors.at(-1))
    process.exit(0)
  }
}
if (task.kind === 'php' && existsSync(`${REPO}/.env.example`) && !existsSync(`${REPO}/.env`)) {
  copyFileSync(`${REPO}/.env.example`, `${REPO}/.env`) // no secrets: .env.example only, for tests (APP_KEY)
  sh('php', ['artisan', 'key:generate', '--no-interaction'])
}

// 2. The agent.
log('system', `Starting agent (max ${task.maxTurns} turns, max $${task.maxBudgetUsd})`)
let lastText = ''
try {
  const options = {
    cwd: REPO,
    settingSources: ['project'], // CLAUDE.md, .claude/settings.json (permissions + hooks), .claude/skills
    permissionMode: 'bypassPermissions', // container is the sandbox; project deny rules and hooks still apply
    disallowedTools: ['WebFetch', 'WebSearch'],
    maxTurns: task.maxTurns,
    maxBudgetUsd: task.maxBudgetUsd,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: INSTRUCTIONS },
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    stderr: data => log('system', `[claude] ${String(data).trim()}`),
  }
  if (task.model)
    options.model = task.model

  for await (const message of query({ prompt: `Task #${task.id}: ${task.title}\n\n${task.prompt}`, options })) {
    emit({ kind: 'sdk', message })
    if (message.type === 'assistant') {
      if (message.error)
        result.apiError = message.error
      const text = (message.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      if (text)
        lastText = text
    }
    if (message.type === 'result') {
      result.subtype = message.subtype
      result.costUsd = message.total_cost_usd ?? null
      result.turns = message.num_turns ?? null
      if (message.subtype === 'success')
        result.summary = message.result ?? ''
      else
        result.errors.push(...(message.errors ?? []).map(String), `Agent stopped: ${message.subtype}`)
    }
  }
}
catch (error) {
  result.errors.push(`Agent crashed: ${error?.message ?? error}`)
  log('error', result.errors.at(-1))
}
if (!result.summary)
  result.summary = lastText
save()

// 3. Commits -> bundle (the runner pushes from the bundle, never from this checkout).
const count = sh('git', ['rev-list', '--count', `origin/${task.baseBranch}..HEAD`])
result.commits = Number.parseInt(count.stdout, 10) || 0
if (sh('git', ['status', '--porcelain']).stdout.trim())
  log('system', 'Uncommitted changes were left in the working tree; they are not part of the PR.')
if (result.commits > 0) {
  const bundle = sh('git', ['bundle', 'create', `${OUT}/branch.bundle`, task.branchName])
  if (bundle.status !== 0)
    result.errors.push(`git bundle failed: ${outputTail(bundle, 20)}`)
}
log('system', `Agent made ${result.commits} commit(s)`)

// 4. Final check with the BASE-BRANCH check script (mounted read-only by the runner). Never run an agent-provided one.
if (result.commits > 0 && task.hasBaseChecks) {
  const [cmd, args] = task.kind === 'php'
    ? ['php', ['scripts/check.php', `--base=origin/${task.baseBranch}`, '--tests']]
    : ['node', ['scripts/check.mjs', `--base=origin/${task.baseBranch}`, '--build']]
  log('system', `Final check: ${cmd} ${args.join(' ')}`)
  const res = sh(cmd, args)
  result.checks = { ran: true, passed: res.status === 0, command: `${cmd} ${args.join(' ')}`, output: outputTail(res) }
  log(res.status === 0 ? 'result' : 'error', `Final check ${res.status === 0 ? 'passed' : 'failed'}`)
}
else if (result.commits > 0) {
  result.checks.output = `The base branch "${task.baseBranch}" has no scripts/check.${task.kind === 'php' ? 'php' : 'mjs'}; final checks were not run.`
}
save()
