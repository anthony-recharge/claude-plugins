export type FlaggedClaim = {
  /** The library, framework, SDK or service the claim is about. */
  subject: string
  /** What the agent stated or assumed, in a few words. */
  claim: string
  /** unsupported | version | workaround | api, or unclassified when the watcher named none of these */
  kind: string
}

export type FindingStatus = 'flagged' | 'nudged' | 'verifying' | 'outdated' | 'confirmed' | 'uncertain' | 'failed'

export type Finding = {
  id: number
  claims: FlaggedClaim[]
  status: FindingStatus
}

declare module 'claude-code' {
  interface PluginState {
    'premise-check': { finding: Finding | null }
  }
}
