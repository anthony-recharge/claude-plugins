import type { RenderElement, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { digest, isVerification, parseWatch, verdictOf } from '../hooks/watch'

const CLAIM = 'Wolverine does not support Dapr, so I wrote a custom adapter.'

function rows(): SessionMessage[] {
  return [
    { role: 'user', text: 'Wire Wolverine up to Dapr pub/sub', toolUses: [] },
    {
      role: 'assistant',
      text: CLAIM,
      toolUses: [{ tool_use_id: 't1', tool: 'Write', input: { file_path: 'src/DaprBridge.cs', content: 'class DaprBridge {}' }, text: 'ok' }],
    },
  ]
}

const FLAG = '{"flag": true, "claims": [{"subject": "WolverineFx", "claim": "has no Dapr transport", "kind": "workaround"}]}'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const BAND = {
  plugin: 'premise-check',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

describe('watch helpers', () => {
  test('digest shows the prompt, the claim and the code, and marks lookups', () => {
    const text = digest(rows(), 0)
    expect(text).toContain('USER: Wire Wolverine')
    expect(text).toContain(CLAIM)
    expect(text).toContain('class DaprBridge')
    const looked: SessionMessage[] = [
      ...rows(),
      { role: 'assistant', text: 'Checking.', toolUses: [{ tool_use_id: 't2', tool: 'WebSearch', input: { query: 'wolverine dapr' } }] },
    ]
    expect(digest(looked, 2)).toContain('[LOOKUP]')
    expect(digest(looked, 2)).toContain('USER (earlier)')
  })

  test('digest is empty when the agent said and wrote nothing new', () => {
    expect(digest(rows(), 2)).toBe('')
  })

  test('parseWatch reads flags leniently and ignores "no"', () => {
    expect(parseWatch(`Sure:\n${FLAG}`)?.[0]?.subject).toBe('WolverineFx')
    expect(parseWatch('{"flag": false}')).toBeUndefined()
    expect(parseWatch('not json')).toBeUndefined()
    expect(parseWatch('{"flag": true, "claims": [{"subject": "X", "claim": "y", "kind": "weird"}]}')?.[0]?.kind).toBe('unsupported')
  })

  test('isVerification counts live sources only', () => {
    expect(isVerification('WebFetch', {})).toBe(true)
    expect(isVerification('mcp__Context7__query-docs', {})).toBe(true)
    expect(isVerification('Bash', { command: 'dotnet package search WolverineFx' })).toBe(true)
    expect(isVerification('Bash', { command: 'dotnet build' })).toBe(false)
  })

  test('verdictOf', () => {
    expect(verdictOf('...\nVERDICT: OUTDATED')).toBe('OUTDATED')
    expect(verdictOf('nothing')).toBe('UNCERTAIN')
  })
})

test('nudge: a flagged claim at turn end reaches the agent', { options: { action: 'nudge' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.messages', () => ({ value: rows() }))
  const asked: string[] = []
  on('model.complete', (_$, e) => (asked.push(`${e.model}|${e.prompt}`), { value: { isAnswered: true, text: FLAG, usage: USAGE } }))
  const told: string[] = []
  on('prompt.submit', (_$, e) => (told.push(e.text), { text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: CLAIM, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' })
  await clock.advance(10)

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('haiku|')
  expect(asked[0]).toContain(CLAIM)
  expect(told.length).toBe(1)
  expect(told[0]).toContain('WolverineFx: has no Dapr transport')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /asked Claude to check/ })).toBeDefined()
  await band.unmount()

  // The same window is not reviewed twice.
  await $.turn.complete({ answer: CLAIM, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't2' })
  await clock.advance(10)
  expect(asked.length).toBe(1)
})

test('ask: the band shows the claim and waits for the person', { options: { action: 'ask' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.messages', () => ({ value: rows() }))
  on('model.complete', () => ({ value: { isAnswered: true, text: FLAG, usage: USAGE } }))
  const told: string[] = []
  on('prompt.submit', (_$, e) => (told.push(e.text), { text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($e, e) => h($e.ui.resolve(e).Box, { key: 'engine' }) as RenderElement)
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: CLAIM, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' })
  await clock.advance(10)
  expect(told.length).toBe(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /has no Dapr transport/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'nudge' })
  expect(told.length).toBe(1)
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /has no Dapr transport/ })).toBeUndefined()
  await ui.unmount()
})

test('off: nothing is reviewed', { options: { action: 'off' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.messages', () => ({ value: rows() }))
  let calls = 0
  on('model.complete', () => (calls++, { value: { isAnswered: true, text: FLAG, usage: USAGE } }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: CLAIM, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' })
  await clock.advance(10)
  expect(calls).toBe(0)
})
