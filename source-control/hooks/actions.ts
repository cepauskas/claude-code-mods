import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'

import type { Busy, DiffSide, DiffView, Entry, LastResult, Status, UiState } from '../types'
import { argv, drawable, expandHunks, fileLines, firstChangedLine, fitDiff, isNoUpstreamError, parseBranches, parseStatus } from './git'
import { PANE, emptyDiff, emptyStatus, emptyUi } from './state'

const statusAtom = atom({ plugin: 'source-control', key: 'status' } as const, emptyStatus, { shape: 'source-control-1' })
const branchesAtom = atom({ plugin: 'source-control', key: 'branches' } as const, [], { shape: 'source-control-1' })
const draftAtom = atom({ plugin: 'source-control', key: 'draft' } as const, '', { shape: 'source-control-1' })
const uiAtom = atom({ plugin: 'source-control', key: 'ui' } as const, emptyUi, { shape: 'source-control-1' })
const diffAtom = atom({ plugin: 'source-control', key: 'diff' } as const, emptyDiff, { shape: 'source-control-2' })

export type GitResult = { ok: boolean; exitCode: number; stdout: string; stderr: string }
export type StateSnapshot = { status: Status; branches: string[]; draft: string; ui: UiState; diff: DiffView }

type Dollar = Pick<EngineInterface, 'process' | 'state' | 'mcp' | 'fs' | 'clock' | 'ui' | 'env'>

const REFRESH_MS = 3000
const DIFF_LIMIT = 60000
const DRAWN_LIMIT = 90000
const EXPAND_STEP = 100
const NOT_A_REPO = /not a git repository/i

let isMessageFocused = false
let isRefreshing = false
let isRefreshPending = false
let isPendingForce = false
let isDeferred = false
let hasReportedHooks = false
let timer: Timer | undefined

export function setMessageFocused(flag: boolean): void {
  isMessageFocused = flag
}

export function takeDeferredRefresh(): boolean {
  const wasDeferred = isDeferred
  isDeferred = false

  return wasDeferred
}

export function startTimer($: Dollar): void {
  timer?.cancel()
  timer = $.clock.every(REFRESH_MS, () => {
    void refresh($)
  })
}

export function stopTimer(): void {
  timer?.cancel()
  timer = undefined
}

export function ensureTimer($: Dollar): void {
  if (timer === undefined) {
    startTimer($)
  }
}

export async function readState($: Dollar): Promise<StateSnapshot> {
  return {
    status: await read($, statusAtom),
    branches: await read($, branchesAtom),
    draft: await read($, draftAtom),
    ui: await read($, uiAtom),
    diff: await read($, diffAtom),
  }
}

export async function setDraft($: Dollar, value: string): Promise<void> {
  await update($, draftAtom, () => value)
}

export async function setMode($: Dollar, mode: UiState['mode']): Promise<void> {
  await updateUi($, ui => ({ ...ui, mode }))
}

async function updateUi($: Dollar, change: (ui: UiState) => UiState): Promise<void> {
  const current = await read($, uiAtom)
  const next = change(current)
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return
  }
  await update($, uiAtom, () => next)
}

export async function runGit($: Dollar, args: string[]): Promise<GitResult> {
  try {
    const result = await $.process.run(args)
    const stdout = result.isStdoutTruncated ? '' : result.stdout
    const exitCode = result.isStdoutTruncated && result.exitCode === 0 ? 1 : result.exitCode

    return { ok: exitCode === 0, exitCode, stdout, stderr: result.isStdoutTruncated ? 'git output too large' : result.stderr }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return { ok: false, exitCode: -1, stdout: '', stderr: `${args[0] ?? 'command'} failed: ${message}` }
  }
}

export async function refresh($: Dollar, options: { force?: boolean } = {}): Promise<void> {
  const force = options.force === true
  if (isRefreshing) {
    isRefreshPending = true
    isPendingForce = isPendingForce || force

    return
  }
  isRefreshing = true
  try {
    await readStatus($, force)
  } finally {
    isRefreshing = false
  }
  if (isRefreshPending) {
    isRefreshPending = false
    const rerunForce = isPendingForce
    isPendingForce = false
    await refresh($, { force: rerunForce })
  }
}

async function paneHasKeyboard($: Dollar): Promise<boolean> {
  try {
    const panes = await $.ui.panes()

    return panes.some(pane => pane.id === PANE && pane.isFocused)
  } catch {
    return false
  }
}

async function readStatus($: Dollar, force: boolean): Promise<void> {
  if (!force && isMessageFocused && (await paneHasKeyboard($))) {
    isDeferred = true

    return
  }
  isDeferred = false
  const readAt = await $.clock.now()
  const status = await runGit($, argv.status())
  if (status.exitCode === 128 && NOT_A_REPO.test(status.stderr)) {
    await writeStatus($, { ...emptyStatus, isRepo: false, readAt })
    await closeDiff($)
    await updateUi($, ui => ({ ...ui, isStatusStale: false }))

    return
  }
  if (!status.ok) {
    await updateUi($, ui => ({ ...ui, isStatusStale: true }))

    return
  }
  const branches = await runGit($, argv.branches())
  await writeStatus($, parseStatus(status.stdout, readAt))
  if (branches.ok) {
    const parsed = parseBranches(branches.stdout)
    const stored = await read($, branchesAtom)
    if (JSON.stringify(parsed) !== JSON.stringify(stored)) {
      await update($, branchesAtom, () => parsed)
    }
  }
  await updateUi($, ui => ({ ...ui, isStatusStale: false }))
  await reloadDiff($)
}

async function writeStatus($: Dollar, next: Status): Promise<void> {
  const stored = await read($, statusAtom)
  if (sameStatus(stored, next)) {
    return
  }
  await update($, statusAtom, () => next)
}

function sameStatus(a: Status, b: Status): boolean {
  const strip = ({ readAt, ...rest }: Status) => rest

  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

export async function setResult($: Dollar, result: LastResult): Promise<void> {
  $.ui.toast(result.text, { timeoutMs: result.kind === 'error' ? 8000 : 4000 })
}

export async function setBusy($: Dollar, busy: Busy | undefined): Promise<void> {
  await updateUi($, ui => ({ ...ui, busy }))
}

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? 'git failed'
}

async function runAction($: Dollar, args: string[], busy?: Busy): Promise<GitResult> {
  await cancelDiscard($)
  if (busy !== undefined) {
    await setBusy($, busy)
  }
  const result = await runGit($, args)
  if (!result.ok) {
    await setResult($, { kind: 'error', text: firstLine(result.stderr) })
  }
  await refresh($, { force: true })
  if (busy !== undefined) {
    await setBusy($, undefined)
  }

  return result
}

export async function stage($: Dollar, path: string): Promise<void> {
  await runAction($, argv.stage(path))
}

export async function stageAll($: Dollar): Promise<void> {
  await runAction($, argv.stageAll())
}

export async function unstage($: Dollar, entry: Entry): Promise<void> {
  await runAction($, argv.unstage(entry))
}

export async function unstageAll($: Dollar): Promise<void> {
  await runAction($, argv.unstageAll())
}

export async function hasRepoHooks($: Dollar): Promise<boolean> {
  const configured = await runGit($, argv.hooksPath())
  if (configured.ok && configured.stdout.trim() !== '') {
    return true
  }
  const dir = await runGit($, argv.hooksDir())
  if (!dir.ok || dir.stdout.trim() === '') {
    return false
  }
  try {
    const entries = await $.fs.list(dir.stdout.trim())

    return entries.some(entry => entry.kind === 'file' && !entry.name.endsWith('.sample'))
  } catch {
    return false
  }
}

export async function commit($: Dollar, message?: string): Promise<void> {
  const text = message ?? (await read($, draftAtom))
  if (text.trim() === '') {
    await setResult($, { kind: 'error', text: 'Commit message is empty' })

    return
  }
  await refresh($, { force: true })
  const status = await read($, statusAtom)
  if (status.staged.length === 0) {
    const stageable = status.unstaged.some(entry => entry.code !== 'U' && entry.code !== 'C')
    if (!stageable) {
      await setResult($, { kind: 'error', text: 'Nothing to commit' })

      return
    }
    const staged = await runAction($, argv.stageTracked(), 'commit')
    if (!staged.ok) {
      return
    }
  }
  const result = await runAction($, argv.commit(text), 'commit')
  if (!result.ok) {
    return
  }
  const sha = /^\[[^\]]* ([0-9a-f]+)\]/.exec(result.stdout)?.[1] ?? ''
  let summary = sha === '' ? 'Committed' : `Committed ${sha}`
  if (!hasReportedHooks && (await hasRepoHooks($))) {
    hasReportedHooks = true
    summary = `${summary} (repo hooks skipped)`
  }
  await setDraft($, '')
  await setResult($, { kind: 'ok', text: summary })
}

export async function push($: Dollar): Promise<void> {
  const first = await runAction($, argv.push(), 'push')
  if (first.ok) {
    await setResult($, { kind: 'ok', text: 'Pushed' })

    return
  }
  if (!isNoUpstreamError(first.stderr)) {
    return
  }
  const branch = (await read($, statusAtom)).branch
  const second = await runAction($, argv.pushSetUpstream(branch), 'push')
  if (second.ok) {
    await setResult($, { kind: 'ok', text: 'Pushed' })
  }
}

export async function checkout($: Dollar, branch: string): Promise<void> {
  const current = (await read($, statusAtom)).branch
  if (branch === current) {
    return
  }
  const result = await runAction($, argv.checkout(branch), 'checkout')
  if (result.ok) {
    await setResult($, { kind: 'ok', text: `Switched to ${branch}` })
  }
}

export async function createBranch($: Dollar, name: string): Promise<void> {
  const trimmed = name.trim()
  await setMode($, 'list')
  if (trimmed === '') {
    return
  }
  const result = await runAction($, argv.createBranch(trimmed), 'checkout')
  if (result.ok) {
    await setResult($, { kind: 'ok', text: `Created ${trimmed}` })
  }
}

export async function toggleDirectory($: Dollar, key: string): Promise<void> {
  await updateUi($, ui => {
    const collapsed = ui.collapsed ?? []

    return {
      ...ui,
      collapsed: collapsed.includes(key) ? collapsed.filter(item => item !== key) : [...collapsed, key],
    }
  })
}

export async function startNewBranch($: Dollar): Promise<void> {
  await updateUi($, ui => ({ ...ui, mode: 'new-branch', pendingDiscard: undefined }))
}

export async function requestDiscard($: Dollar, path: string): Promise<void> {
  await updateUi($, ui => ({ ...ui, pendingDiscard: path }))
}

export async function cancelDiscard($: Dollar): Promise<void> {
  await updateUi($, ui => ({ ...ui, pendingDiscard: undefined }))
}

export async function confirmDiscard($: Dollar, entry: Entry): Promise<void> {
  if (entry.code === 'C') {
    await cancelDiscard($)
    await setResult($, { kind: 'error', text: 'resolve the conflict first' })

    return
  }
  const args = entry.code === 'U' ? argv.discardUntracked(entry.path) : argv.discardTracked(entry.path)
  const result = await runAction($, args)
  if (result.ok) {
    await setResult($, { kind: 'ok', text: `Discarded ${entry.path}` })
  }
}

export async function openDiff($: Dollar, entry: Entry, side: DiffSide, surface: string): Promise<void> {
  if (surface === 'desktop') {
    await showPane($, { pane: 'diff', path: entry.path, diff_scope: 'uncommitted' })

    return
  }
  if (entry.path.endsWith('/')) {
    await setResult($, { kind: 'error', text: `${entry.path} is an untracked directory` })

    return
  }
  const loaded = await loadDiff($, entry, side)
  if (typeof loaded === 'string') {
    await setResult($, { kind: 'error', text: loaded })

    return
  }
  await update($, diffAtom, () => loaded)
}

export async function closeDiff($: Dollar): Promise<void> {
  if ((await read($, diffAtom)).path !== '') {
    await update($, diffAtom, () => emptyDiff)
  }
}

async function loadDiff($: Dollar, entry: Entry, side: DiffSide, expand: number[] = []): Promise<DiffView | string> {
  const isUntracked = entry.code === 'U'
  const args = side === 'staged' ? argv.diffStaged(entry) : isUntracked ? argv.diffUntracked(entry.path) : argv.diffUnstaged(entry.path)
  const result = await runGit($, args)
  const isRead = result.ok || (isUntracked && result.exitCode === 1)
  if (!isRead) {
    return firstLine(result.stderr)
  }
  if (result.stdout.trim() === '') {
    return `No changes in ${entry.path}`
  }
  const { text, hiddenLines } = fitDiff(drawable(result.stdout), DIFF_LIMIT)
  const lines = isUntracked || entry.code === 'D' ? undefined : await readNewSide($, entry.path, side)

  return { ...entry, side, hiddenLines, ...expandHunks(text, lines, expand, hiddenLines > 0) }
}

async function readNewSide($: Dollar, path: string, side: DiffSide): Promise<string[] | undefined> {
  if (side === 'staged') {
    const shown = await runGit($, argv.showStaged(path))

    return shown.ok ? fileLines(drawable(shown.stdout)) : undefined
  }
  try {
    const content = await $.fs.read(path)

    return typeof content === 'string' ? fileLines(drawable(content)) : undefined
  } catch {
    return undefined
  }
}

function entryOf(view: DiffView): Entry {
  return view.origPath === undefined ? { path: view.path, code: view.code } : { path: view.path, code: view.code, origPath: view.origPath }
}

export async function expandDiff($: Dollar, gap: number): Promise<void> {
  const shown = await read($, diffAtom)
  if (shown.path === '') {
    return
  }
  const expand = shown.gaps.map((_, index) => (shown.expand[index] ?? 0) + (index === gap ? EXPAND_STEP : 0))
  const loaded = await loadDiff($, entryOf(shown), shown.side, expand)
  if (typeof loaded === 'string') {
    await setResult($, { kind: 'error', text: loaded })
  } else if (loaded.hunks.join('\n').length > DRAWN_LIMIT) {
    await setResult($, { kind: 'error', text: 'Diff is too large to expand further' })
  } else {
    await update($, diffAtom, () => loaded)
  }
}

async function reloadDiff($: Dollar): Promise<void> {
  const shown = await read($, diffAtom)
  if (shown.path === '') {
    return
  }
  const loaded = await loadDiff($, entryOf(shown), shown.side, shown.expand)
  if (typeof loaded === 'string') {
    await closeDiff($)
  } else if (JSON.stringify(loaded) !== JSON.stringify(shown)) {
    await update($, diffAtom, () => loaded)
  }
}

export async function openFile($: Dollar, entry: Entry, side: DiffSide, surface: string): Promise<void> {
  if (surface === 'desktop') {
    await showPane($, { pane: 'file', path: entry.path })

    return
  }
  if (entry.path.endsWith('/')) {
    await setResult($, { kind: 'error', text: `${entry.path} is an untracked directory` })

    return
  }
  const root = await runGit($, argv.root())
  if (!root.ok) {
    await setResult($, { kind: 'error', text: firstLine(root.stderr) })

    return
  }
  const changed = entry.code === 'U' ? undefined : await runGit($, argv.changedLines(entry, side))
  const line = changed?.ok === true ? firstChangedLine(changed.stdout) : 1
  const pane = await $.env.get('TMUX_PANE')
  const isInTmux = pane !== undefined && pane !== '' && ((await $.env.get('TMUX')) ?? '') !== ''
  const args = isInTmux ? argv.editInTmux(pane, root.stdout.trim(), entry.path, line) : argv.editInCode(root.stdout.trim(), entry.path, line)
  const opened = await runGit($, args)
  if (!opened.ok) {
    await setResult($, { kind: 'error', text: isInTmux ? firstLine(opened.stderr) : 'No editor: start Claude inside tmux, or install the `code` command' })
  }
}

async function showPane($: Dollar, args: Record<string, unknown>): Promise<void> {
  try {
    const result = await $.mcp.call('ccd_view', 'show_pane', args)
    if (result.isError) {
      await setResult($, { kind: 'error', text: JSON.stringify(result.content).slice(0, 120) })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await setResult($, { kind: 'error', text: `show_pane failed: ${message}`.slice(0, 120) })
  }
}
