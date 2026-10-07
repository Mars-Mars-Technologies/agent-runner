/**
 * Files that control the agent's own checks, git hooks or CI. Changes to them are allowed but flagged
 * in the PR ("⚠️ Guardrail files changed" + label touches-guardrails) so a human reviews them closely.
 */
const GUARDRAIL_PATH = /^(?:\.claude\/|\.githooks\/|\.github\/|scripts\/check\.(?:php|mjs)$)/

/** Manifests whose "scripts" section runs code during install/CI (composer/npm hooks). */
export const SCRIPT_MANIFESTS = ['composer.json', 'package.json'] as const

export interface ManifestVersions {
  path: string
  base: string | null
  head: string | null
}

export function isGuardrailPath(path: string): boolean {
  return GUARDRAIL_PATH.test(path)
}

/** True when the "scripts" section differs (or a side can't be parsed). */
export function scriptsSectionChanged(base: string | null, head: string | null): boolean {
  const scripts = (json: string | null): string | undefined => {
    if (json === null)
      return undefined
    const parsed = JSON.parse(json)

    return JSON.stringify(parsed?.scripts ?? null)
  }
  try {
    return scripts(base) !== scripts(head)
  }
  catch {
    return true
  }
}

/** List of guardrail changes for the PR body, e.g. [".github/workflows/ci.yml", "package.json (scripts)"]. */
export function detectGuardrailChanges(changedFiles: string[], manifests: ManifestVersions[]): string[] {
  const found = changedFiles.filter(isGuardrailPath)
  for (const manifest of manifests) {
    if (changedFiles.includes(manifest.path) && scriptsSectionChanged(manifest.base, manifest.head))
      found.push(`${manifest.path} (scripts)`)
  }

  return found
}
