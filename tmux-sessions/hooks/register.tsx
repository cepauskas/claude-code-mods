import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { SessionRow } from '../types'
import { fit, labelOf, parsePanes, parsePids, parseSession, toRows } from './sessions'
import type { Candidate } from './sessions'

const rowsAtom = atom({ plugin: 'tmux-sessions', key: 'rows' } as const, [], { shape: 'tmux-sessions-1' })

const REFRESH_MS = 2000

/**
 * The band above the prompt is one tree that every mod's hook wraps in turn.
 * Each mod that draws a row puts a rule (key `band-rule`) above it and drops
 * the rule of the mods beneath, so one rule shows, as wide as the band.
 */
const RULE_KEY = 'band-rule'

function dropRule(node: RenderElement): RenderElement {
  const children = (node as { children?: unknown }).children
  if (!Array.isArray(children)) {
    return node
  }
  const kept = children
    .filter(child => !(isElement(child) && (child as { props?: { key?: unknown } }).props?.key === RULE_KEY))
    .map(child => (isElement(child) ? dropRule(child) : child))

  return { ...node, children: kept } as RenderElement
}

function isElement(value: unknown): value is RenderElement {
  return typeof value === 'object' && value !== null && 'type' in value
}

let timer: Timer | undefined
let isRefreshing = false

async function selfPane($: EngineInterface): Promise<string | undefined> {
  const pane = await $.env.get('TMUX_PANE')
  const socket = await $.env.get('TMUX')

  return pane !== undefined && pane !== '' && socket !== undefined && socket !== '' ? pane : undefined
}

async function readCandidates($: EngineInterface): Promise<Candidate[]> {
  const home = await $.env.get('HOME')
  if (home === undefined) {
    return []
  }
  const dir = `${home}/.claude/sessions`
  const found: Candidate[] = []
  try {
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) {
        continue
      }
      const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
      const candidate = typeof text === 'string' ? parseSession(text) : undefined
      if (candidate !== undefined) {
        found.push(candidate)
      }
    }
  } catch {
    return []
  }

  return found
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    return
  }
  isRefreshing = true
  try {
    const pane = await selfPane($)
    const candidates = pane === undefined ? [] : await readCandidates($)
    let rows: SessionRow[] = []
    if (pane !== undefined && candidates.length > 0) {
      const running = await $.process.run(['ps', '-o', 'pid=', '-p', candidates.map(candidate => candidate.pid).join(',')])
      const mine = await $.process.run(['tmux', 'list-panes', '-s', '-t', pane, '-F', '#{pane_id}'])
      rows = toRows(candidates, parsePids(running.stdout), pane, parsePanes(mine.stdout))
    }
    if (JSON.stringify(rows) !== JSON.stringify(await read($, rowsAtom))) {
      await update($, rowsAtom, () => rows)
    }
  } catch {
    // A failed read keeps the last list; the next tick tries again.
  } finally {
    isRefreshing = false
  }
}

function ensureTimer($: EngineInterface): void {
  timer ??= $.clock.every(REFRESH_MS, () => {
    void refresh($)
  })
}

async function focus($: EngineInterface, pane: string): Promise<void> {
  try {
    const ran = await $.process.run(['tmux', 'select-window', '-t', pane, ';', 'select-pane', '-t', pane])
    if (ran.exitCode !== 0) {
      $.ui.toast(ran.stderr.split('\n')[0]?.trim() || 'tmux could not focus the pane', { timeoutMs: 6000 })
    }
  } catch (error) {
    $.ui.toast(`tmux failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 120), { timeoutMs: 6000 })
  }
}

function colorOf(status: string): Color {
  if (status === 'busy') {
    return 'warning'
  }

  return status === 'idle' ? 'success' : 'error'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if ((await selfPane($)) !== undefined) {
      await refresh($)
      ensureTimer($)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rows = e.props.hasSurvey ? [] : await read($, rowsAtom)
    if (!rows.some(row => !row.isSelf)) {
      return next(e)
    }
    ensureTimer($)
    const { Box, Text, Button } = $.ui.resolve(e)
    const { shown, hidden } = fit(rows, e.props.bodyColumns)

    return (
      <Box key="tmux-sessions-band" flexDirection="column">
        <Box key={RULE_KEY} height={1} overflow="hidden">
          <Text color="promptBorder">{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
        </Box>
        <Box key="tmux-sessions" flexDirection="row" gap={2}>
          {shown.map(row => (
            <Box key={`session:${row.pane}`} flexDirection="row" gap={1}>
              <Text color={colorOf(row.status)}>●</Text>
              {row.isSelf ? (
                <Text weight="semibold">{labelOf(row)}</Text>
              ) : (
                <Button key={`focus:${row.pane}`} plain dimColor hover={{ dimColor: false, underline: true }} onPress={() => void focus($, row.pane)}>
                  {labelOf(row)}
                </Button>
              )}
            </Box>
          ))}
          {hidden > 0 && <Text dimColor>+{hidden}</Text>}
        </Box>
        {dropRule(await next(e))}
      </Box>
    )
  })
}
