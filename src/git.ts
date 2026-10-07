import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { exec, execOk } from './exec.js'
import type { ManifestVersions } from './guardrails.js'
import { SCRIPT_MANIFESTS } from './guardrails.js'
import type { RepoKind } from './types.js'

/**
 * Host-side git. Two rules keep the host safe from an agent-modified checkout:
 *  1. git only ever runs in workDir/repo BEFORE the container starts (fresh clone);
 *  2. afterwards the branch is read from the bundle the job wrote, into a fresh bare repo the runner owns.
 * Tokens are passed as an http.extraheader via GIT_CONFIG_* env vars: never in argv, URLs or .git/config.
 */

export class TaskError extends Error {}

/** Paths copied from the base branch and mounted read-only over the agent's checkout. */
export const GUARD_PATHS = ['.claude', '.githooks'] as const

export interface PreparedRepo {
  baseSha: string
  kind: RepoKind
  /** Relative paths under workDir/guard to mount read-only at the same place in /work/repo */
  guardPaths: string[]
  /** Base branch has scripts/check.(php|mjs); without it the final check is skipped (never run the agent's copy). */
  hasBaseChecks: boolean
}

export interface BundleInspection {
  commits: number
  descendsFromBase: boolean
  changedFiles: string[]
  manifests: ManifestVersions[]
}

export function authEnv(token: string): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
}

const repoUrl = (githubRepo: string) => `https://github.com/${githubRepo}.git`

export async function prepareRepo(args: {
  githubRepo: string
  token: string
  workDir: string
  baseBranch: string
  branchName: string
  /** Override https://github.com/<repo>.git (tests) */
  remoteUrl?: string
}): Promise<PreparedRepo> {
  const repoDir = join(args.workDir, 'repo')

  await execOk('git', ['clone', '--quiet', '--no-tags', args.remoteUrl ?? repoUrl(args.githubRepo), repoDir], { env: authEnv(args.token) })

  const base = await exec('git', ['-C', repoDir, 'rev-parse', '--verify', `refs/remotes/origin/${args.baseBranch}^{commit}`])
  if (base.code !== 0)
    throw new TaskError(`Base branch '${args.baseBranch}' does not exist in ${args.githubRepo}`)
  const baseSha = base.stdout.trim()

  await execOk('git', ['-C', repoDir, 'switch', '--quiet', '--no-track', '-c', args.branchName, baseSha])

  const kind: RepoKind = existsSync(join(repoDir, 'scripts/check.php')) || (!existsSync(join(repoDir, 'scripts/check.mjs')) && existsSync(join(repoDir, 'composer.json')))
    ? 'php'
    : 'node'
  const checkScript = kind === 'php' ? 'scripts/check.php' : 'scripts/check.mjs'
  const hasBaseChecks = existsSync(join(repoDir, checkScript))

  const guardPaths: string[] = []
  for (const rel of [...GUARD_PATHS, checkScript]) {
    if (!existsSync(join(repoDir, rel)))
      continue
    await mkdir(join(args.workDir, 'guard', rel, '..'), { recursive: true })
    await cp(join(repoDir, rel), join(args.workDir, 'guard', rel), { recursive: true })
    guardPaths.push(rel)
  }

  return { baseSha, kind, guardPaths, hasBaseChecks }
}

/** Load workDir/out/branch.bundle into a fresh bare repo and describe what the agent committed. */
export async function inspectBundle(args: { workDir: string, baseSha: string, branchName: string }): Promise<BundleInspection> {
  const bundle = join(args.workDir, 'out', 'branch.bundle')
  const empty: BundleInspection = { commits: 0, descendsFromBase: true, changedFiles: [], manifests: [] }
  if (!existsSync(bundle))
    return empty

  const bare = join(args.workDir, 'push.git')
  const head = `refs/heads/${args.branchName}`
  const git = (gitArgs: string[]) => exec('git', ['-C', bare, '-c', 'core.hooksPath=/dev/null', ...gitArgs])

  await execOk('git', ['init', '--quiet', '--bare', bare])
  const fetched = await git(['-c', 'transfer.fsckObjects=true', 'fetch', '--quiet', '--no-tags', bundle, `${head}:${head}`])
  if (fetched.code !== 0)
    throw new TaskError(`The job produced an unreadable git bundle: ${fetched.stderr.trim()}`)

  const descends = (await git(['merge-base', '--is-ancestor', args.baseSha, head])).code === 0
  if (!descends)
    return { ...empty, descendsFromBase: false }

  const count = Number((await git(['rev-list', '--count', `${args.baseSha}..${head}`])).stdout.trim()) || 0
  const changedFiles = (await git(['diff', '--name-only', args.baseSha, head])).stdout.split('\n').map(s => s.trim()).filter(Boolean)
  const show = async (ref: string, path: string) => {
    const res = await git(['show', `${ref}:${path}`])

    return res.code === 0 ? res.stdout : null
  }
  const manifests: ManifestVersions[] = []
  for (const path of SCRIPT_MANIFESTS) {
    if (changedFiles.includes(path))
      manifests.push({ path, base: await show(args.baseSha, path), head: await show(head, path) })
  }

  return { commits: count, descendsFromBase: true, changedFiles, manifests }
}

const PROTECTED_BRANCHES = new Set(['main', 'master'])

/**
 * The only refspec the runner may push: refs/heads/claude/task-<id>-<slug>:<same>, without "+" (no force).
 * Throws a TaskError for anything else: main/master, the task's base branch, another task's branch, refspec tricks.
 */
export function pushRefspec(args: { branchName: string, taskId: number, baseBranch: string }): string {
  const { branchName, taskId, baseBranch } = args
  const allowed = new RegExp(`^claude/task-${taskId}-[A-Za-z0-9._-]+$`)

  if (!Number.isInteger(taskId) || taskId <= 0 || !allowed.test(branchName) || branchName.includes('..') || branchName.endsWith('.lock'))
    throw new TaskError(`Refusing to push '${branchName}': only claude/task-${taskId}-* branches may be pushed.`)
  if (branchName === baseBranch || PROTECTED_BRANCHES.has(branchName))
    throw new TaskError(`Refusing to push '${branchName}': it is the base branch or a protected branch.`)

  const ref = `refs/heads/${branchName}`
  const refspec = `${ref}:${ref}`
  if (refspec.startsWith('+'))
    throw new TaskError('Refusing to force-push.')

  return refspec
}

/** Push the task branch from the runner-owned bare repo. Never forces; target ref validated by pushRefspec(). */
export async function pushBranch(args: {
  workDir: string
  githubRepo: string
  branchName: string
  taskId: number
  baseBranch: string
  token: string
  remoteUrl?: string
}): Promise<void> {
  const refspec = pushRefspec(args)
  await execOk('git', ['-C', join(args.workDir, 'push.git'), '-c', 'core.hooksPath=/dev/null', 'push', '--quiet', '--no-force-with-lease', args.remoteUrl ?? repoUrl(args.githubRepo), refspec], {
    env: authEnv(args.token),
  })
}
