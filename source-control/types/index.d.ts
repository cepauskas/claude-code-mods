export type EntryCode = 'M' | 'A' | 'D' | 'R' | 'U' | 'C'

export type Entry = { path: string; origPath?: string; code: EntryCode }

export type Status = {
  branch: string
  upstream?: string
  ahead: number
  behind: number
  staged: Entry[]
  unstaged: Entry[]
  isRepo: boolean
  readAt: number
}

export type Busy = 'commit' | 'push' | 'checkout' | 'refresh'

export type LastResult = { kind: 'ok' | 'error'; text: string }

export type UiState = {
  mode: 'list' | 'new-branch'
  pendingDiscard?: string
  busy?: Busy
  isStatusStale: boolean
  collapsed?: string[]
}

export type DiffSide = 'staged' | 'unstaged'

export type DiffView = {
  path: string
  origPath?: string
  code: EntryCode
  side: DiffSide
  hunks: string[]
  gaps: number[]
  expand: number[]
  hiddenLines: number
}

declare module 'claude-code' {
  interface PluginState {
    'source-control': {
      status: Shaped<Status>
      branches: Shaped<string[]>
      draft: Shaped<string>
      ui: Shaped<UiState>
      diff: Shaped<DiffView>
    }
  }
}
