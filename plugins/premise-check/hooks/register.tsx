import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { FindingStatus, FlaggedClaim } from '../types'
import { CHECKER_PROMPT, WATCHER_SYSTEM, claimKey, digest, listed, lookupsBefore, parseWatch, verdictOf } from './watch'

type Action = 'nudge' | 'verify' | 'ask' | 'off'
const ACTIONS: readonly Action[] = ['nudge', 'verify', 'ask', 'off']
const CHECKER = 'premise-check:checker'

const finding = atom({ plugin: 'premise-check', key: 'finding' } as const, null)

const FRESHNESS = `# Library knowledge freshness

What you know about third-party libraries, frameworks, SDKs, CLIs and hosted services comes from training data with a cutoff, and releases ship fast: integrations get added, APIs change, limits get lifted. Treat that knowledge as possibly stale.

Before you (a) tell the user something cannot be done, is unsupported, or does not exist, (b) state which version is latest or what a version contains, or (c) build a workaround for a feature you believe is missing, check a current source first: Context7 or other docs tools, the package registry, the project's release notes or changelog, or the installed package's source. Say which version you checked, and mind the version the project pins as well as the latest. If you cannot check, say plainly that the claim comes from training data and may be out of date.`

// Module state: a reload drops it, which costs at most one repeated check.
const settings = { action: 'nudge' as Action, watcherModel: 'haiku', checkerModel: 'haiku', everySteps: 6 }
let checkedUpTo = 0
let isWatching = false
let isWatchQueued = false
let isTurnRunning = false
let nextId = 1
const flaggedKeys = new Set<string>()
const pending = new Map<string, { id: number; claims: FlaggedClaim[] }>()

async function actionOf($: EngineInterface): Promise<Action> {
  const stored = await $.store.get('action')
  return ACTIONS.includes(stored as Action) ? (stored as Action) : settings.action
}

async function setStatus($: EngineInterface, id: number, status: FindingStatus): Promise<void> {
  await update($, finding, f => (f !== null && f.id === id ? { ...f, status } : f))
}

/** Puts a note in front of the main agent: inside the running turn if there is one, else as a new turn. */
async function tellAgent($: EngineInterface, text: string): Promise<void> {
  if (isTurnRunning) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } else {
    await $.prompt.submit({ text })
  }
}

async function nudge($: EngineInterface, id: number, claims: FlaggedClaim[]): Promise<void> {
  await tellAgent(
    $,
    `[premise-check] A watcher noticed you may be relying on training-data knowledge that could be out of date:

${listed(claims)}

Before going further, check each against a current source (package registry, release notes or changelog, current docs via Context7 if available, or the installed package's source), for both the latest release and the version this project pins. If it holds, say which version you checked. If not, correct what you told the user and anything you built on it. Ignore any item that is about this project's own code.`,
  )
  await setStatus($, id, 'nudged')
}

async function verify($: EngineInterface, id: number, claims: FlaggedClaim[]): Promise<void> {
  const spawned = await $.agent.spawn({
    subagentType: CHECKER,
    description: `Check ${claims.length} library claim${claims.length === 1 ? '' : 's'}`,
    prompt: `The agent stated or assumed, without checking a live source:\n${listed(claims)}\n\nCheck what the newest releases say, not what you remember.`,
    model: settings.checkerModel,
  })
  if (spawned.agentId === undefined) {
    await setStatus($, id, 'failed')
    return
  }
  pending.set(spawned.agentId, { id, claims })
  await setStatus($, id, 'verifying')
}

/** One pass of the watcher over what happened since the last pass. */
async function watch($: EngineInterface): Promise<void> {
  if (isWatching) {
    isWatchQueued = true
    return
  }
  isWatching = true
  try {
    const action = await actionOf($)
    if (action === 'off') return
    const messages = await $.session.messages()
    if (checkedUpTo > messages.length) checkedUpTo = 0 // a /clear or compaction
    const window = digest(messages, checkedUpTo)
    const lookups = lookupsBefore(messages, checkedUpTo)
    checkedUpTo = messages.length
    if (window === '') return

    const already = [...flaggedKeys]
    const reply = await $.model.complete({
      model: settings.watcherModel,
      system: [{ text: WATCHER_SYSTEM, cache: true }],
      prompt: `Lookups the agent already made earlier in the session:\n${lookups.length > 0 ? lookups.join('\n') : '(none)'}\n\nAlready flagged, do not repeat:\n${already.length > 0 ? already.join('\n') : '(none)'}\n\nNew activity to review ([LOOKUP] marks a live-source check):\n${window}`,
      maxTokens: 400,
      timeoutMs: 60000,
    })
    if (!reply.isAnswered) return
    const claims = parseWatch(reply.text)?.filter(c => !flaggedKeys.has(claimKey(c)))
    if (claims === undefined || claims.length === 0) return
    for (const c of claims) flaggedKeys.add(claimKey(c))

    const id = nextId++
    await update($, finding, () => ({ id, claims, status: 'flagged' as const }))
    $.ui.toast(`premise-check: ${claims[0]?.subject ?? 'a claim'} may rest on stale knowledge`)
    if (action === 'nudge') await nudge($, id, claims)
    else if (action === 'verify') await verify($, id, claims)
  } finally {
    isWatching = false
    if (isWatchQueued) {
      isWatchQueued = false
      $.clock.after(0, () => void watch($))
    }
  }
}

const STATUS_TEXT: Record<FindingStatus, string> = {
  flagged: 'unverified',
  nudged: 'asked Claude to check',
  verifying: 'checker is looking it up…',
  outdated: 'checker: outdated, Claude was told',
  confirmed: 'checker: still holds',
  uncertain: 'checker: could not tell',
  failed: 'checker could not start',
}

export const register: Register = (on, options) => {
  settings.action = ACTIONS.includes(options.action as Action) ? (options.action as Action) : 'nudge'
  if (typeof options.watcherModel === 'string' && options.watcherModel !== '') settings.watcherModel = options.watcherModel
  if (typeof options.checkerModel === 'string' && options.checkerModel !== '') settings.checkerModel = options.checkerModel
  if (typeof options.everySteps === 'number' && options.everySteps >= 1) settings.everySteps = Math.floor(options.everySteps)

  on('session.start', async ($, e, next) => {
    await $.agent.register({
      name: 'checker',
      description: 'Verifies claims about third-party software against current registries, release notes and docs.',
      prompt: CHECKER_PROMPT,
      disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Agent'],
      omitClaudeMd: true,
    })
    await $.command.register({
      name: 'premise-check',
      description: 'Run the stale-knowledge watcher now, or set what it does when it flags something.',
      argumentHint: '[now | nudge | verify | ask | off | status]',
    })
    return next(e)
  })

  // The checker is this plugin's own; the main agent gets the system-prompt rule instead.
  on('agent.offer', { agent: CHECKER }, () => ({ isOffered: false }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare') || e.traits.includes('analysis')) return composed
    return { ...composed, sections: [...composed.sections, { id: 'premise-check:freshness', text: FRESHNESS, scope: 'session' }] }
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = true
    return next(e)
  })

  // Every few model requests of a long main-loop turn, look at what happened so far.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && e.index > 0 && e.index % settings.everySteps === 0) $.clock.after(0, () => void watch($))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      isTurnRunning = false
      $.clock.after(0, () => void watch($))
      return result
    }
    const job = pending.get(e.agentId)
    if (job === undefined) return result
    pending.delete(e.agentId)
    if (e.reason !== 'answer') {
      await setStatus($, job.id, 'failed')
      return result
    }
    const verdict = verdictOf(e.answer)
    if (verdict === 'OUTDATED') {
      await setStatus($, job.id, 'outdated')
      await tellAgent(
        $,
        `[premise-check] An independent check found that something you relied on is outdated or wrong for current releases.

What you stated or assumed:
${listed(job.claims)}

The checker's findings:
${e.answer.trim()}

Re-evaluate with this in mind, tell the user what changed, and revise any code or plan built on the old premise.`,
      )
    } else {
      await setStatus($, job.id, verdict === 'CONFIRMED' ? 'confirmed' : 'uncertain')
    }
    return result
  })

  on('command.run', { command: 'premise-check' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (ACTIONS.includes(arg as Action)) {
      await $.store.set('action', arg)
      return { text: `premise-check: on a flagged claim it will now ${arg === 'off' ? 'do nothing (watching is off)' : arg}.` }
    }
    if (arg === 'now') {
      checkedUpTo = Math.max(0, checkedUpTo - 40)
      $.clock.after(0, () => void watch($))
      return { text: `premise-check: ${settings.watcherModel} is reviewing the recent conversation.` }
    }
    if (arg === '' || arg === 'status') {
      return {
        text: `premise-check: watcher ${settings.watcherModel}, checker ${settings.checkerModel}, on a flag: ${await actionOf($)} (default ${settings.action}). Flagged this session: ${flaggedKeys.size}. Checks running: ${pending.size}.\nUsage: /premise-check now | nudge | verify | ask | off`,
      }
    }
    return { text: `premise-check: unknown argument "${arg}". Use now | nudge | verify | ask | off | status.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, finding)
    if (f === null || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const id = f.id
    const canAct = f.status === 'flagged' || f.status === 'failed' || f.status === 'uncertain'
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="yellow">Heads up: </Text>
          Claude may be relying on stale knowledge <Text dimColor>({STATUS_TEXT[f.status]})</Text>
        </Text>
        {f.claims.map((c, i) => (
          <Text key={`c${i}`} dimColor>
            {'  '}• {c.subject}: {c.claim}
          </Text>
        ))}
        <Box>
          {canAct ? <Button key="nudge" hotkey="1" plain label="Ask Claude to check" onPress={() => nudge($, id, f.claims)} /> : null}
          {canAct ? <Text> </Text> : null}
          {canAct ? <Button key="verify" hotkey="2" plain label="Verify independently" onPress={() => verify($, id, f.claims)} /> : null}
          {canAct ? <Text> </Text> : null}
          <Button key="dismiss" hotkey="0" plain label="Dismiss" onPress={() => update($, finding, () => null)} />
        </Box>
      </Box>
    )
  })
}
