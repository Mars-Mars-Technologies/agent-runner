import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { HmsApi } from './api.js'
import { loadConfig, secretValues } from './config.js'
import { removeContainer, removeStaleContainers, startContainer } from './docker.js'
import { inspectBundle, prepareRepo, pushBranch } from './git.js'
import { GitHubApp } from './github.js'
import { makeRedactor } from './redact.js'
import type { RunnerDeps } from './runTask.js'
import { runTask } from './runTask.js'

const SHUTDOWN_GRACE_MS = 60_000

async function main(): Promise<void> {
  const config = loadConfig()
  const redact = makeRedactor(secretValues(config))
  const log = (message: string) => console.log(`${new Date().toISOString()} [${config.runnerId}] ${redact(message)}`)
  const api = new HmsApi(config.apiUrl, config.runnerToken, config.runnerId)

  const deps: RunnerDeps = {
    config,
    api,
    github: new GitHubApp(config.github),
    git: { prepareRepo, inspectBundle, pushBranch },
    docker: { start: startContainer, remove: removeContainer },
    redact,
    log,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  }

  // Startup recovery: leftovers from a crash/restart of this runner.
  await mkdir(config.workDir, { recursive: true })
  const stale = await removeStaleContainers(config.runnerId)
  if (stale.length)
    log(`removed stale containers: ${stale.join(', ')}`)
  for (const entry of await readdir(config.workDir)) {
    if (entry.startsWith('task-'))
      await rm(join(config.workDir, entry), { recursive: true, force: true })
  }
  log(`recovered ${await api.recover()} orphaned running task(s)`)

  const running = new Map<number, { controller: AbortController, done: Promise<void> }>()
  const stop = new AbortController()
  let pausedUntil = 0

  const shutdown = (signalName: string) => {
    if (stop.signal.aborted)
      return
    log(`${signalName} received: stopping (${running.size} task(s) running)`)
    stop.abort()
    for (const { controller } of running.values())
      controller.abort()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  log(`started: max ${config.maxConcurrent} concurrent task(s), timeout ${config.taskTimeoutMs / 60_000} min, max ${config.maxTurns} turns, $${config.maxBudgetUsd} budget`)

  while (!stop.signal.aborted) {
    let claimedOne = false
    if (Date.now() >= pausedUntil && running.size < config.maxConcurrent) {
      try {
        const claimed = await api.claim()
        if (claimed) {
          claimedOne = true
          const { id } = claimed.task
          const controller = new AbortController()
          log(`task ${id}: claimed (${claimed.githubRepo}, branch ${claimed.task.branch_name})`)
          const done = runTask(claimed, deps, controller.signal).then((outcome) => {
            log(`task ${id}: ${outcome.status}`)
            if (outcome.pauseMs) {
              pausedUntil = Date.now() + outcome.pauseMs
              log(`pausing new tasks for ${outcome.pauseMs / 60_000} min after a Claude API auth/billing error`)
            }
          }).finally(() => running.delete(id))
          running.set(id, { controller, done })
        }
      }
      catch (error: any) {
        log(`claim failed: ${error?.message ?? error}`)
      }
    }
    // Claim again right away while there is capacity; otherwise wait for the next poll.
    if (!claimedOne || running.size >= config.maxConcurrent)
      await sleep(config.pollIntervalMs, undefined, { signal: stop.signal }).catch(() => {})
  }

  await Promise.race([
    Promise.allSettled([...running.values()].map(r => r.done)),
    sleep(SHUTDOWN_GRACE_MS),
  ])
  log('stopped')
  process.exit(0)
}

main().catch((error) => {
  console.error(`agent-runner failed to start: ${error?.message ?? error}`)
  process.exit(1)
})
