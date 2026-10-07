import type { LogEntry, LogType, TaskStatus } from './types.js'
import { truncate } from './redact.js'

const MAX_MESSAGE = 4000 // API accepts 10k; keep entries readable
const MAX_BATCH = 200 // API limit per request
const MAX_PENDING = 2000 // drop oldest beyond this if the API is unreachable

export interface LogSink {
  appendLogs: (taskId: number, entries: LogEntry[]) => Promise<TaskStatus>
}

/**
 * Buffers log entries for one task and ships them to hms-api in batches. Every flush (also empty ones,
 * as a heartbeat) returns the task status, which is how the runner learns that a user cancelled the task.
 */
export class LogStream {
  private pending: LogEntry[] = []
  private timer: NodeJS.Timeout | undefined
  private lastFlush = 0
  private flushing: Promise<void> | undefined
  private dropped = 0
  status: TaskStatus = 'running'

  constructor(
    private readonly sink: LogSink,
    private readonly taskId: number,
    private readonly redact: (text: string) => string,
    private readonly onStatus: (status: TaskStatus) => void = () => {},
    private readonly options = { flushMs: 2000, heartbeatMs: 5000 },
  ) {}

  push(type: LogType, message: string): void {
    this.pending.push({ type, message: truncate(this.redact(message), MAX_MESSAGE) })
    if (this.pending.length > MAX_PENDING) {
      this.dropped += this.pending.length - MAX_PENDING
      this.pending.splice(0, this.pending.length - MAX_PENDING)
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.pending.length || Date.now() - this.lastFlush >= this.options.heartbeatMs)
        void this.flush()
    }, this.options.flushMs)
  }

  /** Send pending entries (or a heartbeat) now; resolves with the latest known status. */
  async flush(): Promise<TaskStatus> {
    if (this.flushing)
      await this.flushing
    this.flushing = this.doFlush().finally(() => {
      this.flushing = undefined
    })
    await this.flushing

    return this.status
  }

  private async doFlush(): Promise<void> {
    if (this.dropped) {
      this.pending.unshift({ type: 'runner', message: `${this.dropped} log entries dropped (API unreachable)` })
      this.dropped = 0
    }
    do {
      const batch = this.pending.slice(0, MAX_BATCH)
      try {
        const status = await this.sink.appendLogs(this.taskId, batch)
        this.pending.splice(0, batch.length)
        this.lastFlush = Date.now()
        if (status !== this.status) {
          this.status = status
          this.onStatus(status)
        }
      }
      catch (error: any) {
        if (error?.status !== 422)
          return // keep entries; retry on the next tick
        this.pending.splice(0, batch.length) // rejected by validation: retrying would block the stream forever
      }
    } while (this.pending.length)
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    await this.flush()
  }
}
