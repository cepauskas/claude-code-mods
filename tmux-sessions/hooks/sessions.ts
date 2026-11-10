import type { SessionRow } from '../types'

export type Candidate = Omit<SessionRow, 'isSelf'>

const PANE = /(%\d+)$/
const NAME_WIDTH = 24

/**
 * Reads one file of the engine's session registry (`~/.claude/sessions/<pid>.json`).
 * Only a session inside tmux is kept: its `tmux` field ends with the pane id.
 * The registry is the engine's own and undocumented, so every field is checked.
 */
export function parseSession(text: string): Candidate | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const { pid, tmux, name, cwd, status } = raw as Record<string, unknown>
  const pane = typeof tmux === 'string' ? PANE.exec(tmux)?.[1] : undefined
  if (typeof pid !== 'number' || pane === undefined) {
    return undefined
  }
  const folder = typeof cwd === 'string' ? cwd.slice(cwd.lastIndexOf('/') + 1) : ''
  const label = typeof name === 'string' && name !== '' ? name : folder

  return { pid, pane, name: drawable(label === '' ? pane : label), status: typeof status === 'string' ? drawable(status) : 'unknown' }
}

export function parsePids(stdout: string): Set<number> {
  return new Set(stdout.split('\n').map(line => Number(line.trim())).filter(pid => pid > 0))
}

export function parsePanes(stdout: string): Set<string> {
  return new Set(stdout.split('\n').map(line => line.trim()).filter(line => line !== ''))
}

/** Keeps the live sessions whose pane belongs to `panes`, the panes of this tmux session. */
export function toRows(candidates: Candidate[], alive: Set<number>, selfPane: string, panes: Set<string>): SessionRow[] {
  return candidates
    .filter(candidate => alive.has(candidate.pid) && panes.has(candidate.pane))
    .map(candidate => ({ ...candidate, isSelf: candidate.pane === selfPane }))
    .sort((a, b) => Number(a.pane.slice(1)) - Number(b.pane.slice(1)))
}

/** The rows that fit one line of `columns` cells, and how many were left out. */
export function fit(rows: SessionRow[], columns: number): { shown: SessionRow[]; hidden: number } {
  const shown: SessionRow[] = []
  let used = 0
  for (const row of rows) {
    const width = widthOf(row) + (shown.length === 0 ? 0 : 2)
    if (used + width > columns - 4) {
      break
    }
    shown.push(row)
    used += width
  }

  return { shown, hidden: rows.length - shown.length }
}

export function labelOf(row: SessionRow): string {
  const name = row.name.length <= NAME_WIDTH ? row.name : `${row.name.slice(0, NAME_WIDTH - 1)}…`

  return row.status === 'busy' || row.status === 'idle' ? name : `${name} (${row.status})`
}

function widthOf(row: SessionRow): number {
  return 2 + labelOf(row).length
}

function drawable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, '')
}
