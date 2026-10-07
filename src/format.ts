import type { LogEntry } from './types.js'
import { truncate } from './redact.js'

const MAX_TEXT = 4000
const MAX_TOOL_RESULT = 2000
const MAX_TOOL_INPUT = 500

/**
 * Turn one Claude Agent SDK message (as streamed by job/run-job.mjs) into log entries.
 * Only the fields we display are read; unknown message types are skipped.
 */
export function formatSdkMessage(message: any): LogEntry[] {
  switch (message?.type) {
    case 'system':
      if (message.subtype !== 'init')
        return []

      return [{
        type: 'system',
        message: `Session started: model ${message.model}, permission mode ${message.permissionMode}, `
          + `${message.tools?.length ?? 0} tools, skills: ${(message.skills ?? []).join(', ') || 'none'}`,
      }]

    case 'assistant': {
      const entries: LogEntry[] = []
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim())
          entries.push({ type: 'assistant', message: truncate(block.text.trim(), MAX_TEXT) })
        else if (block.type === 'tool_use')
          entries.push({ type: 'tool', message: `${block.name}: ${describeToolInput(block.name, block.input)}` })
      }
      if (message.error)
        entries.push({ type: 'error', message: `Claude API error: ${message.error}` })

      return entries
    }

    case 'user': {
      const content = message.message?.content
      if (!Array.isArray(content))
        return []

      return content
        .filter((block: any) => block.type === 'tool_result')
        .map((block: any) => ({
          type: 'tool_result' as const,
          message: truncate(`${block.is_error ? 'ERROR: ' : ''}${toolResultText(block.content)}`, MAX_TOOL_RESULT),
        }))
    }

    case 'result': {
      const cost = typeof message.total_cost_usd === 'number' ? `$${message.total_cost_usd.toFixed(4)}` : 'n/a'
      const errors = message.errors?.length ? ` — ${message.errors.join('; ')}` : ''

      return [{
        type: message.subtype === 'success' ? 'result' : 'error',
        message: `Agent finished: ${message.subtype}, ${message.num_turns} turns, cost ${cost}${errors}`,
      }]
    }

    default:
      return []
  }
}

function describeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object')
    return ''
  const summary
    = name === 'Bash' ? input.command
      : input.file_path ?? input.path ?? input.pattern ?? input.skill ?? input.description ?? JSON.stringify(input)

  return truncate(String(summary ?? ''), MAX_TOOL_INPUT)
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string')
    return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part?.type === 'text' ? part.text : `[${part?.type ?? 'content'}]`))
      .join('\n')
  }

  return ''
}
