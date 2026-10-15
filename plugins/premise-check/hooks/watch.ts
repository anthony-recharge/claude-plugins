// Pure helpers: what the Haiku watcher is shown, how its answer is read, and
// which tool calls count as having looked something up.

import type { SessionMessage } from 'claude-code'
import type { FlaggedClaim } from '../types'

export const WATCHER_SYSTEM = `You watch a coding agent's session for one failure: the agent relying on its training data about third-party software (libraries, frameworks, SDKs, CLIs, hosted services) when that knowledge may be outdated. Releases ship fast; integrations get added and limitations get lifted after a model's training cutoff.

Flag a claim when the agent, WITHOUT having checked a live source (web search, web fetch, docs tool, package registry, release notes, or the installed package's source) for that same thing:
- says a library or service cannot do something, does not support or integrate with something, lacks a feature, or that something is deprecated or removed (kind: unsupported)
- states which version is latest or what a given version contains (kind: version)
- builds a workaround, shim, custom adapter or hand-rolled replacement because it believes a feature is missing (kind: workaround)
- writes code against an API of a fast-moving library in a way that hinges on details likely to have changed, and says nothing about having checked (kind: api; use sparingly)

Do NOT flag:
- statements about the project's own code, files, tests or errors seen in tool output
- things the agent verified via a lookup listed in the transcript
- things the user stated themselves
- general, stable facts (language syntax, long-established standard library behaviour)
- claims listed as already flagged

The bar is high: most windows have nothing to flag. Answer with JSON only, no prose:
{"flag": false}
or
{"flag": true, "claims": [{"subject": "<library or service>", "claim": "<what was stated or assumed, under 15 words>", "kind": "unsupported|version|workaround|api"}]}
At most 3 claims.`

export const CHECKER_PROMPT = `You fact-check claims another AI agent made about third-party software (libraries, frameworks, SDKs, CLIs, hosted services) from possibly stale training data. Assume the claims may be outdated: newer releases often add the capability that was said to be missing. Do not answer from memory.

For each claim:
1. Find the current truth from live sources, newest first: the package registry (npm https://registry.npmjs.org/<pkg>/latest, NuGet https://api.nuget.org/v3-flatcontainer/<id-lowercase>/index.json, PyPI https://pypi.org/pypi/<pkg>/json, crates.io https://crates.io/api/v1/crates/<name>, Go https://proxy.golang.org/<module>/@v/list, RubyGems https://rubygems.org/api/v1/versions/<gem>/latest.json), GitHub releases and changelogs, official docs (Context7 tools if available), and web search. Look for integrations shipped as separate packages too (e.g. "<Lib>.<Other>" or "<lib>-<other>").
2. If the working directory is a project, check which version it pins (package.json, *.csproj, Directory.Packages.props, pyproject.toml, Cargo.toml, go.mod, ...): a capability may exist only in a newer version than the one pinned.

Do not edit files. Be brief and concrete: versions, package names, links.

End your answer with exactly one line:
VERDICT: OUTDATED   (at least one claim is wrong or outdated for the current release)
VERDICT: CONFIRMED  (every claim still holds for the current release)
VERDICT: UNCERTAIN  (you could not establish it either way)`

// Shell commands that ask a registry, a release feed or a package manager what exists now.
const REGISTRY_COMMAND =
  /\b(?:npm (?:view|info|show|outdated|search)|pnpm (?:view|info|outdated)|yarn (?:info|npm info|outdated)|pip3? (?:index|show|download)|uv pip (?:show|index)|poetry show|dotnet (?:package search|list[\s\S]*--outdated)|nuget (?:search|list)|cargo (?:search|info)|go list -m|gem (?:search|info|list -r)|composer (?:show|outdated)|mvn [\s\S]*versions:|gh (?:release|api|repo view)|brew info|apt(?:-cache)? (?:show|policy))\b|\bcurl\b[\s\S]*(?:registry\.npmjs|api\.nuget|nuget\.org|pypi\.org|crates\.io|proxy\.golang|rubygems\.org|packagist|search\.maven|api\.github\.com|github\.com\/[^\s/]+\/[^\s/]+\/releases)/i
// Paths that hold an installed dependency's real source.
const INSTALLED_SOURCE = /(?:node_modules|\.nuget[\\/]packages|site-packages|\.cargo[\\/]registry|go[\\/]pkg[\\/]mod|[\\/]vendor[\\/]|\.m2[\\/]repository|\.gradle[\\/]caches)/
const DOC_MCP = /context7|docs|documentation|deepwiki|release|search|fetch|browse|web/i

/** Whether one tool call looked at a current source rather than memory. */
export function isVerification(tool: string, input: Record<string, unknown>): boolean {
  if (tool === 'WebSearch' || tool === 'WebFetch') return true
  if (tool.startsWith('mcp__')) return DOC_MCP.test(tool)
  if (tool === 'Bash') return typeof input.command === 'string' && REGISTRY_COMMAND.test(input.command)
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
    const where = [input.file_path, input.path, input.pattern].filter(v => typeof v === 'string').join(' ')
    return INSTALLED_SOURCE.test(where)
  }
  return false
}

function clip(text: string, max: number): string {
  const flat = text.trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)} …[${flat.length - max} more chars]`
}

const INPUT_KEYS = ['command', 'query', 'url', 'file_path', 'path', 'pattern', 'libraryName', 'libraryId', 'topic', 'description'] as const

function describeToolUse(tool: string, input: Record<string, unknown>): string {
  const parts = INPUT_KEYS.flatMap(k => (typeof input[k] === 'string' ? [`${k}=${clip(String(input[k]), 200)}`] : []))
  const written = [input.new_string, input.content].find(v => typeof v === 'string')
  const code = typeof written === 'string' ? `\n    code: ${clip(written, 500).replace(/\n/g, '\n    ')}` : ''
  const lookup = isVerification(tool, input) ? ' [LOOKUP]' : ''
  return `  -> ${tool}(${parts.join(', ')})${lookup}${code}`
}

function isPrompt(m: SessionMessage): boolean {
  return m.role === 'user' && (m.toolResults === undefined || m.toolResults.length === 0) && m.text.trim() !== ''
}

/**
 * The transcript window the watcher reads: the person's latest prompt, then the
 * agent's text and tool calls from `from` on. Empty when the window holds
 * nothing the agent said or wrote.
 */
export function digest(messages: readonly SessionMessage[], from: number, maxChars = 12000): string {
  const lines: string[] = []
  let said = false
  for (let i = Math.max(0, from); i < messages.length; i++) {
    const m = messages[i]
    if (m === undefined) continue
    if (isPrompt(m)) {
      lines.push(`USER: ${clip(m.text, 1500)}`)
      continue
    }
    if (m.role !== 'assistant') continue
    if (m.text.trim() !== '') {
      lines.push(`AGENT: ${clip(m.text, 2500)}`)
      said = true
    }
    for (const u of m.toolUses) {
      lines.push(describeToolUse(u.tool, u.input))
      if (typeof u.input.new_string === 'string' || typeof u.input.content === 'string') said = true
    }
  }
  if (!said) return ''
  const hasPrompt = lines.some(l => l.startsWith('USER: '))
  if (!hasPrompt) {
    for (let i = Math.min(from, messages.length) - 1; i >= 0; i--) {
      const m = messages[i]
      if (m !== undefined && isPrompt(m)) {
        lines.unshift(`USER (earlier): ${clip(m.text, 1500)}`)
        break
      }
    }
  }
  const text = lines.join('\n')
  return text.length <= maxChars ? text : `…\n${text.slice(text.length - maxChars)}`
}

/** Every lookup the session made before `upTo`, so the watcher knows what was already checked. */
export function lookupsBefore(messages: readonly SessionMessage[], upTo: number): string[] {
  const found: string[] = []
  for (let i = 0; i < Math.min(upTo, messages.length); i++) {
    for (const u of messages[i]?.toolUses ?? []) {
      if (isVerification(u.tool, u.input)) found.push(describeToolUse(u.tool, { ...u.input, new_string: undefined, content: undefined }).trim())
    }
  }
  return found.slice(-20)
}

const KINDS = new Set(['unsupported', 'version', 'workaround', 'api'])

/** The watcher's JSON answer, read leniently; undefined when it flagged nothing usable. */
export function parseWatch(reply: string): FlaggedClaim[] | undefined {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { flag, claims } = parsed as { flag?: unknown; claims?: unknown }
  if (flag !== true || !Array.isArray(claims)) return undefined
  const out: FlaggedClaim[] = []
  for (const c of claims) {
    if (typeof c !== 'object' || c === null) continue
    const { subject, claim, kind } = c as Record<string, unknown>
    if (typeof subject !== 'string' || typeof claim !== 'string' || subject.trim() === '' || claim.trim() === '') continue
    out.push({ subject: subject.trim(), claim: claim.trim(), kind: typeof kind === 'string' && KINDS.has(kind) ? kind : 'unsupported' })
  }
  return out.length > 0 ? out.slice(0, 3) : undefined
}

export function claimKey(c: FlaggedClaim): string {
  return `${c.subject} ${c.claim}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function listed(claims: readonly FlaggedClaim[]): string {
  return claims.map(c => `- ${c.subject}: ${c.claim} (${c.kind})`).join('\n')
}

export type Verdict = 'OUTDATED' | 'CONFIRMED' | 'UNCERTAIN'

/** The checker ends its report with `VERDICT: <word>`; anything else reads as uncertain. */
export function verdictOf(report: string): Verdict {
  const m = /VERDICT:\s*\**\s*(OUTDATED|CONFIRMED|UNCERTAIN)/i.exec(report)
  return (m?.[1]?.toUpperCase() as Verdict | undefined) ?? 'UNCERTAIN'
}
