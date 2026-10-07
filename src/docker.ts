import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { posix } from 'node:path'
import { exec } from './exec.js'

export interface ContainerSpec {
  name: string
  image: string
  runnerId: string
  taskId: number
  uid: number
  gid: number
  memory: string
  /** Memory + swap total (docker --memory-swap) */
  memorySwap: string
  cpus: string
  workDir: string
  /** Paths (relative to the repo) to mount read-only from workDir/guard over workDir/repo */
  guardPaths: string[]
  /** Passed by name (-e NAME) so values never appear in argv / `ps` */
  env: Record<string, string>
}

export interface RunningContainer {
  done: Promise<number>
  kill: () => Promise<void>
}

/** docker run arguments: non-root, no capabilities, resource limits, only the task workdir mounted. */
export function buildDockerArgs(spec: ContainerSpec): string[] {
  const args = [
    'run',
    '--name', spec.name,
    '--label', `agent-runner=${spec.runnerId}`,
    '--label', `agent-task=${spec.taskId}`,
    '--user', `${spec.uid}:${spec.gid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '2048',
    '--memory', spec.memory,
    '--memory-swap', spec.memorySwap,
    '--cpus', spec.cpus,
    '-v', `${posix.join(spec.workDir, 'repo')}:/work/repo`,
    '-v', `${posix.join(spec.workDir, 'out')}:/work/out`,
    '-v', `${posix.join(spec.workDir, 'task.json')}:/work/task.json:ro`,
  ]
  for (const rel of spec.guardPaths)
    args.push('-v', `${posix.join(spec.workDir, 'guard', rel)}:/work/repo/${rel}:ro`)
  for (const name of Object.keys(spec.env))
    args.push('-e', name)
  args.push(spec.image)

  return args
}

export function startContainer(
  spec: ContainerSpec,
  onStdoutLine: (line: string) => void,
  onStderrLine: (line: string) => void,
): RunningContainer {
  const child = spawn('docker', buildDockerArgs(spec), {
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  createInterface({ input: child.stdout }).on('line', onStdoutLine)
  createInterface({ input: child.stderr }).on('line', onStderrLine)

  const done = new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve(code ?? 1))
  })

  return {
    done,
    kill: async () => {
      await exec('docker', ['kill', spec.name])
    },
  }
}

export async function removeContainer(name: string): Promise<void> {
  await exec('docker', ['rm', '--force', name])
}

/** Remove containers left by a previous run of this runner (crash/restart). Returns their names. */
export async function removeStaleContainers(runnerId: string): Promise<string[]> {
  const listed = await exec('docker', ['ps', '--all', '--quiet', '--filter', `label=agent-runner=${runnerId}`, '--format', '{{.Names}}'])
  const names = listed.stdout.split('\n').map(s => s.trim()).filter(Boolean)
  for (const name of names)
    await removeContainer(name)

  return names
}
