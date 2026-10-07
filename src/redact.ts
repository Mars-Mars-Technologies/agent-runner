const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[\w-]{10,}/g, '[REDACTED]'],
  [/\bgh[opsur]_\w{20,}/g, '[REDACTED]'],
  [/\bgithub_pat_\w{20,}/g, '[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/(x-access-token:)[^@\s]+@/gi, '$1[REDACTED]@'],
  [/(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, '$1[REDACTED]'],
  // KEY=value / "key": "value" style dumps of env vars or config (printenv, .env, JSON)
  [/(\b[\w.-]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|APP_KEY)[\w.-]*\b["']?\s*[=:]\s*["']?)[^\s"',]+/gi, '$1[REDACTED]'],
]

/** Returns a function that removes known secret values and secret-looking strings from text. */
export function makeRedactor(secrets: Array<string | undefined>): (text: string) => string {
  const literals = secrets
    .flatMap(s => (s ? [s.trim()] : []))
    .filter(s => s.length >= 8)
    .sort((a, b) => b.length - a.length)

  return (text: string) => {
    let out = text
    for (const secret of literals)
      out = out.split(secret).join('[REDACTED]')
    for (const [pattern, replacement] of PATTERNS)
      out = out.replace(pattern, replacement)

    return out
  }
}

/** Keep the head of long text and say how much was cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max)
    return text

  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`
}

/** Keep the tail of long text (useful for command output, where errors are at the end). */
export function tail(text: string, max: number): string {
  if (text.length <= max)
    return text

  return `[… ${text.length - max} chars omitted]\n${text.slice(-max)}`
}
