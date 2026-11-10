import type { DiffView, Status, UiState } from '../types'

export const PANE = 'source-control'
export const PANE_TITLE = 'Source Control'

export const emptyStatus: Status = {
  branch: '',
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  isRepo: true,
  readAt: 0,
}

export const emptyUi: UiState = {
  mode: 'list',
  isStatusStale: false,
}

export const emptyDiff: DiffView = {
  path: '',
  code: 'M',
  side: 'unstaged',
  hunks: [],
  gaps: [],
  expand: [],
  hiddenLines: 0,
}
