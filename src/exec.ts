import { spawn } from 'node:child_process'
import { tail } from './redact.js'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
  /** Merged over process.env */
  env?: Record<string, string>
  timeoutMs?: number
}

export function exec(cmd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

/** exec() that throws on a non-zero exit; the message carries the command name and the tail of stderr. */
export async function execOk(cmd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const result = await exec(cmd, args, options)
  if (result.code !== 0)
    throw new Error(`${cmd} ${args.find(a => !a.startsWith('-')) ?? ''} failed (exit ${result.code}): ${tail(result.stderr.trim(), 1500)}`)

  return result
}
