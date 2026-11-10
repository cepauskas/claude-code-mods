import type { Color, EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { Entry, EntryCode } from '../types'
import {
  cancelDiscard,
  checkout,
  closeDiff,
  commit,
  confirmDiscard,
  createBranch,
  ensureTimer,
  expandDiff,
  openDiff,
  openFile,
  push,
  readState,
  refresh,
  requestDiscard,
  setDraft,
  setMode,
  stage,
  stageAll,
  startNewBranch,
  toggleDirectory,
  unstage,
  unstageAll,
} from './actions'

const NEW_BRANCH = '__new__'
const DETACHED = '(detached)'
const FIXED_ROWS = 8
const MESSAGE_ROWS = 3
const EXPAND_STEP = 100

const CODE_COLORS: Record<EntryCode, Color> = {
  M: 'warning',
  A: 'diffAdded',
  D: 'diffRemoved',
  R: 'claude',
  U: 'success',
  C: 'error',
}

type PaneInput = RenderInput<'Pane'>

export async function renderPane($: EngineInterface, e: PaneInput): Promise<RenderElement> {
  const elements = $.ui.resolve(e)
  if (!('Input' in elements) || !('Select' in elements)) {
    const { Text: Plain } = elements

    return <Plain dimColor>Source Control needs a surface with text fields.</Plain>
  }
  const { Box, Text, Button, Input, Select, Code } = elements
  ensureTimer($)
  const { status, branches, draft, ui, diff } = await readState($)

  if (!status.isRepo) {
    return (
      <Box key="no-repo" flexDirection="column" padding={1} gap={1}>
        <Text color="warning" weight="semibold">Not a git repository</Text>
        <Text dimColor>Open a folder with a .git directory, then refresh.</Text>
        <Box>
          <Button key="refresh" onPress={() => void refresh($, { force: true })}>
            Refresh
          </Button>
        </Box>
      </Box>
    )
  }

  const bodyRows = e.props.scroll.bodyRows
  const bodyColumns = e.props.bodyColumns

  if (diff.path !== '') {
    const isStaged = diff.side === 'staged'
    const gapRow = (index: number): RenderElement | false => {
      const hidden = diff.gaps[index] ?? 0

      return (
        hidden > 0 && (
          <Button key={`expand:${index}`} plain dimColor hover={{ dimColor: false, underline: true }} onPress={() => void expandDiff($, index)}>
            ⋯ Show {Math.min(EXPAND_STEP, hidden)} of {hidden} hidden lines
          </Button>
        )
      )
    }

    return (
      <Box key="diff-view" flexDirection="column" paddingX={1} paddingY={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Button key="diff-back" onPress={() => void closeDiff($)}>
            ← Back
          </Button>
          <Text color={CODE_COLORS[diff.code]} weight="semibold" mono>
            {diff.code}
          </Text>
          <Text weight="semibold">{shorten(diff.path, Math.max(8, bodyColumns - 34))}</Text>
          <Text dimColor size="footnote">
            {isStaged ? 'staged' : 'not staged'}
          </Text>
          <Box flexGrow={1} />
          <Button key="diff-file" plain dimColor hover={{ dimColor: false }} onPress={() => void openFile($, diff, diff.side, e.surface)}>
            ↗ Edit
          </Button>
          {isStaged ? (
            <Button key="diff-unstage" plain dimColor hover={{ dimColor: false }} onPress={() => void unstage($, diff)}>
              − Unstage
            </Button>
          ) : (
            <Button key="diff-stage" plain dimColor hover={{ dimColor: false }} onPress={() => void stage($, diff.path)}>
              + Stage
            </Button>
          )}
        </Box>
        <Box marginTop={1} flexDirection="column">
          {diff.hunks.flatMap((hunk, index) => [gapRow(index), <Code source={hunk} format="diff" path={diff.path} />])}
          {gapRow(diff.hunks.length)}
        </Box>
        {diff.hiddenLines > 0 && (
          <Text dimColor size="footnote">
            … {diff.hiddenLines} more lines not shown
          </Text>
        )}
      </Box>
    )
  }
  const budget = Math.max(1, bodyRows - FIXED_ROWS)
  const pathWidth = Math.max(8, bodyColumns - 10)
  const total = status.staged.length + status.unstaged.length
  const stagedShown = byDirectory(status.staged).slice(0, budget)
  const unstagedShown = byDirectory(status.unstaged).slice(0, Math.max(0, budget - stagedShown.length))
  const hidden = total - stagedShown.length - unstagedShown.length

  const isDetached = status.branch === DETACHED
  const branchOptions = [
    ...branches.map(name => ({ value: name, label: name })),
    ...(status.branch !== '' && !isDetached && !branches.includes(status.branch)
      ? [{ value: status.branch, label: status.branch }]
      : []),
    { value: NEW_BRANCH, label: '+ New branch…' },
  ]
  const selectedBranch = branchOptions.some(option => option.value === status.branch) ? status.branch : undefined
  const isBusy = ui.busy !== undefined

  const fileRow = (entry: Entry, side: 'staged' | 'unstaged'): RenderElement => {
    if (ui.pendingDiscard === entry.path && side === 'unstaged') {
      return (
        <Box flexDirection="row" alignItems="center" gap={1} paddingLeft={dirOf(entry.path) === '' ? 1 : 3}>
          <Text color="warning">Discard {entry.path}?</Text>
          <Button key={`discard-yes:${entry.path}`} variant="primary" onPress={() => void confirmDiscard($, entry)}>
            Yes
          </Button>
          <Button key={`discard-no:${entry.path}`} onPress={() => void cancelDiscard($)}>
            No
          </Button>
        </Box>
      )
    }

    return (
      <Box key={`row:${side}:${entry.path}`} flexDirection="row" alignItems="center" gap={1} paddingLeft={dirOf(entry.path) === '' ? 1 : 3}>
        <Text color={CODE_COLORS[entry.code]} weight="semibold" mono>
          {entry.code}
        </Text>
        <Box flexGrow={1}>
          <Button key={`open:${entry.path}`} plain dimColor hover={{ dimColor: false, underline: true }} onPress={() => void openDiff($, entry, side, e.surface)}>
            {shorten(baseOf(entry.path), pathWidth)}
          </Button>
        </Box>
        <Button key={`file:${entry.path}`} plain dimColor hover={{ dimColor: false }} onPress={() => void openFile($, entry, side, e.surface)}>
          ↗
        </Button>
        {side === 'staged' ? (
          <Button key={`unstage:${entry.path}`} plain dimColor hover={{ dimColor: false }} onPress={() => void unstage($, entry)}>
            −
          </Button>
        ) : (
          <Button key={`stage:${entry.path}`} plain dimColor hover={{ dimColor: false }} onPress={() => void stage($, entry.path)}>
            +
          </Button>
        )}
        {side === 'unstaged' && (
          <Button key={`discard:${entry.path}`} plain dimColor hover={{ dimColor: false }} onPress={() => void requestDiscard($, entry.path)}>
            ⟲
          </Button>
        )}
      </Box>
    )
  }

  const collapsed = new Set(ui.collapsed ?? [])
  const tree = (entries: Entry[], side: 'staged' | 'unstaged'): RenderElement[] => {
    const rows: RenderElement[] = []
    let lastDir: string | undefined
    for (const entry of entries) {
      const dir = dirOf(entry.path)
      const dirKey = `dir:${side}:${dir}`
      if (dir !== '' && dir !== lastDir) {
        const isCollapsed = collapsed.has(dirKey)
        rows.push(
          <Box key={`dirrow:${side}:${dir}`} flexDirection="row" alignItems="center" gap={1} paddingLeft={1}>
            <Button key={dirKey} plain dimColor hover={{ dimColor: false }} onPress={() => void toggleDirectory($, dirKey)}>
              {isCollapsed ? '▸' : '▾'} {dir}
            </Button>
          </Box>,
        )
      }
      lastDir = dir
      if (dir === '' || !collapsed.has(dirKey)) {
        rows.push(fileRow(entry, side))
      }
    }

    return rows
  }

  const sectionHeader = (title: string, count: number, action: RenderElement | false): RenderElement => (
    <Box key={`section:${title}`} flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1} marginBottom={0}>
      <Text weight="semibold" size="footnote" color="subtle">
        {title} ({count})
      </Text>
      {action}
    </Box>
  )

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {ui.mode === 'new-branch' ? (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Input
            key="new-branch"
            placeholder="new branch name"
            submitLabel="create"
            autoFocus
            onSubmit={value => void createBranch($, value)}
          />
          <Button key="new-branch-cancel" onPress={() => void setMode($, 'list')}>
            Cancel
          </Button>
        </Box>
      ) : (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Select
            key="branch"
            label="Branch"
            options={branchOptions}
            value={selectedBranch}
            onSelect={value => void (value === NEW_BRANCH ? startNewBranch($) : checkout($, value))}
          />
          {isDetached && <Text color="warning">{DETACHED}</Text>}
          {status.upstream === undefined ? (
            <Text dimColor size="footnote">no upstream</Text>
          ) : (
            <Box flexDirection="row" gap={1}>
              <Text color={status.ahead > 0 ? 'success' : undefined} dimColor={status.ahead === 0} tabular>
                ↑{status.ahead}
              </Text>
              <Text color={status.behind > 0 ? 'warning' : undefined} dimColor={status.behind === 0} tabular>
                ↓{status.behind}
              </Text>
            </Box>
          )}
          {ui.isStatusStale && (
            <Text color="warning" size="footnote">
              status unavailable
            </Text>
          )}
        </Box>
      )}
      <Box flexDirection="column" alignItems="stretch" width="100%" marginTop={1} marginBottom={1}>
        <Input
          key="message"
          placeholder="Commit message (Enter to commit)"
          rows={MESSAGE_ROWS}
          value={draft}
          onInput={value => void setDraft($, value)}
          onSubmit={value => void (isBusy ? undefined : commit($, value))}
        />
      </Box>
      <Box key="actions" flexDirection="row" alignItems="center" gap={1}>
        <Button key="commit" variant="primary" onPress={() => void (isBusy ? undefined : commit($))}>
          {ui.busy === 'commit' ? 'Committing…' : 'Commit'}
        </Button>
        <Button key="push" variant="secondary" onPress={() => void (isBusy ? undefined : push($))}>
          {ui.busy === 'push' ? 'Pushing…' : 'Push'}
        </Button>
        <Box flexGrow={1} />
        <Button key="refresh" plain dimColor hover={{ dimColor: false }} onPress={() => void refresh($, { force: true })}>
          Refresh
        </Button>
      </Box>
      {total === 0 && (
        <Box marginTop={1} paddingLeft={1}>
          <Text dimColor>No changes</Text>
        </Box>
      )}
      {total > 0 &&
        sectionHeader(
          'Staged Changes',
          status.staged.length,
          status.staged.length > 0 && (
            <Button key="unstage-all" plain dimColor hover={{ dimColor: false }} onPress={() => void unstageAll($)}>
              Unstage All
            </Button>
          ),
        )}
      {tree(stagedShown, 'staged')}
      {total > 0 &&
        sectionHeader(
          'Changes',
          status.unstaged.length,
          status.unstaged.length > 0 && (
            <Button key="stage-all" plain dimColor hover={{ dimColor: false }} onPress={() => void stageAll($)}>
              Stage All
            </Button>
          ),
        )}
      {tree(unstagedShown, 'unstaged')}
      {hidden > 0 && (
        <Box paddingLeft={1}>
          <Text dimColor size="footnote">
            … and {hidden} more
          </Text>
        </Box>
      )}
    </Box>
  )
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/', path.length - 2)

  return index === -1 ? '' : path.slice(0, index)
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/', path.length - 2) + 1)
}

function byDirectory(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    const dirs = dirOf(a.path).localeCompare(dirOf(b.path))

    return dirs !== 0 ? dirs : baseOf(a.path).localeCompare(baseOf(b.path))
  })
}

function shorten(path: string, width: number): string {
  if (path.length <= width) {
    return path
  }

  return `…${path.slice(path.length - width + 1)}`
}
