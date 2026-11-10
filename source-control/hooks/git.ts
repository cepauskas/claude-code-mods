import type { Entry, EntryCode, Status } from '../types'

const STATUS_ARGV = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z']

/**
 * Runs nano on file `$1` at line `$2` in the tmux pane it is started in, and
 * closes that pane on the first save; leaving nano closes the pane by itself.
 * `-w` keeps long lines whole: macOS ships pico as nano, which wraps them.
 */
export const EDIT_SCRIPT = [
  'm() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }',
  'was=$(m "$1")',
  '(while kill -0 $$ 2>/dev/null; do sleep 0.3; if [ "$(m "$1")" != "$was" ]; then sleep 0.2; tmux kill-pane -t "$TMUX_PANE"; fi; done) &',
  'exec nano -w "+$2" "$1"',
].join('\n')

const DIFF_ARGV = ['git', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff']

export const argv = {
  status: (): string[] => [...STATUS_ARGV],
  branches: (): string[] => ['git', 'branch', '--format=%(refname:short)'],
  stage: (path: string): string[] => ['git', 'add', '--', path],
  stageAll: (): string[] => ['git', 'add', '-A'],
  unstage: (entry: Entry): string[] =>
    entry.origPath === undefined
      ? ['git', 'restore', '--staged', '--', entry.path]
      : ['git', 'restore', '--staged', '--', entry.path, entry.origPath],
  unstageAll: (): string[] => ['git', 'restore', '--staged', '--', '.'],
  stageTracked: (): string[] => ['git', 'add', '-u'],
  commit: (message: string): string[] => ['git', 'commit', '-m', message],
  push: (): string[] => ['git', 'push'],
  pushSetUpstream: (branch: string): string[] => ['git', 'push', '--set-upstream', 'origin', branch],
  checkout: (branch: string): string[] => ['git', 'checkout', branch],
  createBranch: (name: string): string[] => ['git', 'checkout', '-b', name],
  discardTracked: (path: string): string[] => ['git', 'checkout', '--', path],
  discardUntracked: (path: string): string[] => ['git', 'clean', '-f', '--', path],
  diffStaged: (entry: Entry): string[] => [
    ...DIFF_ARGV,
    '--cached',
    '--',
    entry.path,
    ...(entry.origPath === undefined ? [] : [entry.origPath]),
  ],
  diffUnstaged: (path: string): string[] => [...DIFF_ARGV, '--', path],
  diffUntracked: (path: string): string[] => [...DIFF_ARGV, '--no-index', '--', '/dev/null', path],
  changedLines: (entry: Entry, side: 'staged' | 'unstaged'): string[] => [
    ...DIFF_ARGV,
    '-U0',
    ...(side === 'staged' ? ['--cached'] : []),
    '--',
    entry.path,
  ],
  root: (): string[] => ['git', 'rev-parse', '--show-toplevel'],
  editInTmux: (pane: string, root: string, path: string, line: number): string[] => [
    'tmux', 'split-window', '-h', '-t', pane, '-c', root, 'sh', '-c', EDIT_SCRIPT, 'edit', `./${path}`, String(line),
  ],
  editInCode: (root: string, path: string, line: number): string[] => ['code', '-g', `${root}/${path}:${line}`],
  showStaged: (path: string): string[] => ['git', 'show', `:${path}`],
  hooksPath: (): string[] => ['git', 'config', '--get', 'core.hooksPath'],
  hooksDir: (): string[] => ['git', 'rev-parse', '--git-path', 'hooks'],
}

export function isNoUpstreamError(stderr: string): boolean {
  return /no upstream branch|has no upstream/i.test(stderr)
}

export function parseBranches(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}

export function parseStatus(stdout: string, readAt: number): Status {
  const status: Status = {
    branch: '',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    isRepo: true,
    readAt,
  }
  const records = stdout.split('\0')

  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? ''
    if (record === '') {
      continue
    }
    if (record.startsWith('# ')) {
      readHeader(record, status)
      continue
    }
    const kind = record[0]
    if (kind === '1') {
      readChanged(record, status, 8)
    } else if (kind === '2') {
      index++
      readChanged(record, status, 9, records[index])
    } else if (kind === 'u') {
      status.unstaged.push({ path: fieldsAfter(record, 10), code: 'C' })
    } else if (kind === '?') {
      status.unstaged.push({ path: record.slice(2), code: 'U' })
    }
  }

  return status
}

function readHeader(line: string, status: Status): void {
  const [key, ...rest] = line.slice(2).split(' ')
  const value = rest.join(' ')
  if (key === 'branch.head') {
    status.branch = value
  } else if (key === 'branch.upstream') {
    status.upstream = value
  } else if (key === 'branch.ab') {
    const match = /\+(\d+) -(\d+)/.exec(value)
    if (match !== null) {
      status.ahead = Number(match[1])
      status.behind = Number(match[2])
    }
  }
}

function readChanged(line: string, status: Status, pathField: number, origPath?: string): void {
  const xy = line.slice(2, 4)
  const path = fieldsAfter(line, pathField)
  const indexCode = xy[0] ?? '.'
  const worktreeCode = xy[1] ?? '.'

  if (indexCode !== '.') {
    const entry: Entry = { path, code: toCode(indexCode) }
    if (origPath !== undefined && origPath !== '') {
      entry.origPath = origPath
    }
    status.staged.push(entry)
  }
  if (worktreeCode !== '.') {
    status.unstaged.push({ path, code: toCode(worktreeCode) })
  }
}

function fieldsAfter(line: string, count: number): string {
  let index = 0
  for (let seen = 0; seen < count; seen++) {
    const next = line.indexOf(' ', index)
    if (next === -1) {
      return ''
    }
    index = next + 1
  }

  return line.slice(index)
}

const PORCELAIN_COPIED = 'C'

function toCode(letter: string): EntryCode {
  if (letter === PORCELAIN_COPIED) {
    return 'A'
  }
  if (letter === 'A' || letter === 'D' || letter === 'R') {
    return letter
  }

  return 'M'
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/**
 * Cuts `git diff` output down to its hunks, at most `limit` characters.
 * A hunk cut short gets its header counts rewritten, so the rest still parses.
 * Output with no hunk (a binary file, a mode change) is returned as it is.
 */
export function fitDiff(raw: string, limit: number): { text: string; hiddenLines: number } {
  const lines = raw.replace(/\n$/, '').split('\n')
  const first = lines.findIndex(line => line.startsWith('@@'))
  if (first === -1) {
    return { text: lines.join('\n').slice(0, limit), hiddenLines: 0 }
  }
  const kept: string[] = []
  let size = 0
  let lastHeader = -1
  for (const line of lines.slice(first)) {
    if (size + line.length + 1 > limit) {
      break
    }
    if (line.startsWith('@@')) {
      lastHeader = kept.length
    }
    kept.push(line)
    size += line.length + 1
  }
  const isCut = kept.length < lines.length - first
  if (isCut && lastHeader !== -1) {
    const body = kept.slice(lastHeader + 1)
    if (body.length === 0) {
      kept.length = lastHeader
    } else {
      kept[lastHeader] = recount(kept[lastHeader] ?? '', body)
    }
  }

  return { text: kept.join('\n'), hiddenLines: lines.length - first - kept.length }
}

function recount(header: string, body: string[]): string {
  const match = HUNK_HEADER.exec(header)
  if (match === null) {
    return header
  }
  const before = body.filter(line => line.startsWith(' ') || line.startsWith('-')).length
  const after = body.filter(line => line.startsWith(' ') || line.startsWith('+')).length

  return `@@ -${match[1]},${before} +${match[2]},${after} @@${match[3]}`
}

type Hunk = { header: string; oldFirst: number; newFirst: number; tail: string; body: string[]; isGrown: boolean }

const countOf = (body: string[], sign: string): number =>
  body.filter(line => line.startsWith(' ') || line.startsWith(sign)).length

function parseHunks(text: string): Hunk[] | undefined {
  const hunks: Hunk[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const match = HUNK_HEADER.exec(line)
      if (match === null) {
        return undefined
      }
      hunks.push({ header: line, oldFirst: Number(match[1]), newFirst: Number(match[2]), tail: match[3] ?? '', body: [], isGrown: false })
    } else if (hunks.length === 0) {
      return undefined
    } else {
      hunks[hunks.length - 1]?.body.push(line)
    }
  }
  for (const hunk of hunks) {
    // A side with no lines is numbered by the line before it.
    hunk.oldFirst += countOf(hunk.body, '-') === 0 ? 1 : 0
    hunk.newFirst += countOf(hunk.body, '+') === 0 ? 1 : 0
  }

  return hunks
}

function printHunk(hunk: Hunk): string {
  if (!hunk.isGrown) {
    return [hunk.header, ...hunk.body].join('\n')
  }
  const before = countOf(hunk.body, '-')
  const after = countOf(hunk.body, '+')
  const header = `@@ -${before === 0 ? hunk.oldFirst - 1 : hunk.oldFirst},${before} +${after === 0 ? hunk.newFirst - 1 : hunk.newFirst},${after} @@${hunk.tail}`

  return [header, ...hunk.body].join('\n')
}

/**
 * Splits a diff into its hunks and counts the unchanged lines hidden around them:
 * `gaps[i]` sits above hunk `i`, the last one below the last hunk.
 * `expand[i]` lines of gap `i` are drawn: the ones next to the first hunk for
 * the top gap, the ones following the hunk above for every other gap.
 * `lines` is the new side of the file; without it nothing can be expanded.
 */
export function expandHunks(
  text: string,
  lines: string[] | undefined,
  expand: number[],
  isCut = false,
): { hunks: string[]; gaps: number[]; expand: number[] } {
  const hunks = parseHunks(text)
  if (hunks === undefined || lines === undefined) {
    return { hunks: [text], gaps: [], expand: [] }
  }
  const wanted = expand.length === hunks.length + 1 ? expand : hunks.map(() => 0).concat(0)
  const gaps: number[] = []
  let next = 1
  for (let index = 0; index <= hunks.length; index++) {
    const hunk = hunks[index]
    const end = hunk === undefined ? (isCut ? 0 : lines.length) : Math.min(hunk.newFirst - 1, lines.length)
    const size = Math.max(0, end - next + 1)
    const count = Math.min(wanted[index] ?? 0, size)
    const first = hunks[0]
    const above = hunks[index - 1]
    if (count > 0 && index === 0 && first !== undefined) {
      first.body.unshift(...lines.slice(end - count, end).map(line => ` ${line}`))
      first.oldFirst -= count
      first.newFirst -= count
      first.isGrown = true
    } else if (count > 0 && above !== undefined) {
      above.body.push(...lines.slice(next - 1, next - 1 + count).map(line => ` ${line}`))
      above.isGrown = true
    }
    gaps.push(size - count)
    if (hunk !== undefined) {
      next = hunk.newFirst + countOf(hunk.body, '+')
    }
  }

  return { hunks: hunks.map(printHunk), gaps, expand: wanted }
}

export function fileLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines
}

/** Drops the control characters a drawn text may not hold; tab and newline stay. */
export function drawable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

/** The first changed line on the new side of a diff, 1 when it has no hunk. */
export function firstChangedLine(diff: string): number {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(diff)

  return match === null ? 1 : Math.max(1, Number(match[1]))
}
