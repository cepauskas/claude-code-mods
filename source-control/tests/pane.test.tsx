import type { On, ProcessRunResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { EDIT_SCRIPT } from '../hooks/git'

type Answer = Partial<ProcessRunResult>

export const PLUGIN = 'source-control'
export const STATUS = 'git --no-optional-locks status --porcelain=v2 --branch -z'
export const H = '100644 100644 100644 1111111 2222222'
export const CLEAN = '# branch.head main\u0000'

export const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'source-control',
  props: {
    title: 'Source Control',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

export function fakeGit(
  on: On,
  answers: Record<string, Answer | Answer[]>,
  isPlaced = true,
  files: Record<string, string> = {},
  env: Record<string, string> = {},
) {
  const calls: string[] = []
  const mcp: Array<{ tool: string; args: Record<string, unknown> }> = []
  const state: Record<string, unknown> = {}
  const toasts: string[] = []
  const writes: Record<string, number> = {}
  const clock = mock.clock(on)
  let isPaneFocused = false
  on('process.run', (_, e) => {
    const key = e.argv.join(' ')
    calls.push(key)
    const found = answers[key]
    const answer = Array.isArray(found) ? (found.shift() ?? {}) : (found ?? {})

    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...answer },
    }
  })
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.read', (_, e) => {
    const content = Object.entries(files).find(([name]) => e.path === name || e.path.endsWith(`/${name}`))?.[1]
    if (content === undefined) {
      throw new Error(`no such file: ${e.path}`)
    }

    return { value: content }
  })
  on('mcp.call', (_, e) => {
    mcp.push({ tool: e.tool, args: e.args })

    return { value: { content: [], isError: false } }
  })
  on('state.set', (_, e, next) => {
    const raw = e.value as { shape?: string; value?: unknown } | undefined
    state[e.key] = raw !== undefined && typeof raw === 'object' && 'shape' in raw ? raw.value : raw
    writes[e.key] = (writes[e.key] ?? 0) + 1

    return next(e)
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [{ id: 'source-control', title: 'Source Control', isShown: true, isFocused: isPaneFocused, isPlaced: true }],
  }))
  on('ui.focus', () => ({}))
  on('command.register', () => ({ value: { command: 'source-control' } }))
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return {
    calls,
    mcp,
    writes,
    clock,
    toasts,
    focusPane: (flag: boolean) => {
      isPaneFocused = flag
    },
    status: () => state.status as { staged: unknown[]; unstaged: unknown[]; isRepo: boolean } | undefined,
    ui: () => state.ui as { mode: string; pendingDiscard?: string; isStatusStale: boolean } | undefined,
    draft: () => state.draft as string | undefined,
  }
}

test('draws both groups with counts and file rows', async ($, on) => {
  fakeGit(on, { [STATUS]: { stdout: `${CLEAN}1 M. N... ${H} src/a.ts\u00001 A. N... ${H} src/b.ts\u00001 .M N... ${H} src/c.ts\u0000` } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Staged Changes/ }))?.text).toBe('Staged Changes (2)')
    expect((await ui.find({ type: 'Text', text: /^Changes/ }))?.text).toBe('Changes (1)')
    expect(await ui.find({ type: 'Button', key: 'unstage:src/a.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'stage:src/c.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'open:src/b.ts' })).toBeDefined()
    expect((await ui.find({ type: 'Select', key: 'branch' }))?.props.value).toBe('main')
    await ui.unmount()
  }
})

test('empty tree shows No changes', async ($, on) => {
  fakeGit(on, { [STATUS]: { stdout: CLEAN } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No changes/ }))?.text).toBe('No changes')
  await ui.unmount()
})

test('not a repo shows the message and only the refresh button', async ($, on) => {
  fakeGit(on, { [STATUS]: { exitCode: 128, stderr: 'fatal: not a git repository' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Not a git repository/ }))?.text).toBe('Not a git repository')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
  await ui.unmount()
})

test('pressing discard shows the inline confirmation, No restores the row', async ($, on) => {
  const git = fakeGit(on, { [STATUS]: { stdout: `${CLEAN}1 .M N... ${H} src/a.ts\u0000` } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'discard:src/a.ts' })
  expect((await ui.find({ type: 'Text', text: /Discard src\/a\.ts\?/ }))?.text).toBe('Discard src/a.ts?')
  expect(await ui.find({ type: 'Button', key: 'discard-yes:src/a.ts' })).toBeDefined()
  await ui.press({ key: 'discard-no:src/a.ts' })
  expect(await ui.find({ type: 'Button', key: 'discard-yes:src/a.ts' })).toBe(undefined)
  expect(await ui.find({ type: 'Button', key: 'discard:src/a.ts' })).toBeDefined()
  expect(git.calls.filter(call => call.startsWith('git checkout'))).toEqual([])
  await ui.unmount()
})

test('confirming discard runs checkout for tracked and clean for untracked', async ($, on) => {
  const git = fakeGit(on, { [STATUS]: { stdout: `${CLEAN}1 .M N... ${H} src/a.ts\u0000? new.md\u0000` } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'discard:src/a.ts' })
  await ui.press({ key: 'discard-yes:src/a.ts' })
  await ui.press({ key: 'discard:new.md' })
  await ui.press({ key: 'discard-yes:new.md' })
  expect(git.calls).toContain('git checkout -- src/a.ts')
  expect(git.calls).toContain('git clean -f -- new.md')
  await ui.unmount()
})

test('discard of a conflicted file is refused', async ($, on) => {
  const git = fakeGit(on, { [STATUS]: { stdout: `${CLEAN}u UU N... 100644 100644 100644 100644 1 2 3 both.ts\u0000` } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'discard:both.ts' })
  await ui.press({ key: 'discard-yes:both.ts' })
  expect(git.calls.filter(call => call.includes('both.ts'))).toEqual([])
  expect(git.toasts).toContain('resolve the conflict first')
  expect(await ui.find({ type: 'Text', text: /resolve the conflict first/ })).toBe(undefined)
  await ui.unmount()
})

test('stage, unstage and the all buttons call git', async ($, on) => {
  const git = fakeGit(on, { [STATUS]: { stdout: `${CLEAN}1 M. N... ${H} src/a.ts\u00001 .M N... ${H} src/b.ts\u0000` } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'stage:src/b.ts' })
  await ui.press({ key: 'unstage:src/a.ts' })
  await ui.press({ key: 'stage-all' })
  await ui.press({ key: 'unstage-all' })
  expect(git.calls).toContain('git add -- src/b.ts')
  expect(git.calls).toContain('git restore --staged -- src/a.ts')
  expect(git.calls).toContain('git add -A')
  expect(git.calls).toContain('git restore --staged -- .')
  await ui.unmount()
})

test('path click opens the diff pane for tracked and untracked files; the file icon opens the editor', async ($, on) => {
  const git = fakeGit(on, { [STATUS]: { stdout: `${CLEAN}1 .M N... ${H} src/a.ts\u0000? new.md\u0000` } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open:src/a.ts' })
  await ui.press({ key: 'open:new.md' })
  await ui.press({ key: 'file:new.md' })
  expect(git.mcp).toEqual([
    { tool: 'show_pane', args: { pane: 'diff', path: 'src/a.ts', diff_scope: 'uncommitted' } },
    { tool: 'show_pane', args: { pane: 'diff', path: 'new.md', diff_scope: 'uncommitted' } },
    { tool: 'show_pane', args: { pane: 'file', path: 'new.md' } },
  ])
  await ui.unmount()
})

test('message input stores the draft and Enter commits', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: `${CLEAN}1 M. N... ${H} src/a.ts\u0000` },
    'git commit -m fix': { stdout: '[main 1a2b3c4] fix' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'message', text: 'fix', kind: 'change' })
  expect(git.draft()).toBe('fix')
  await ui.input({ key: 'message', text: 'fix' })
  expect(git.calls).toContain('git commit -m fix')
  expect(git.draft()).toBe('')
  expect(git.toasts).toContain('Committed 1a2b3c4')
  await ui.unmount()
})

test('commit button with empty message reports it and calls no git', async ($, on) => {
  const git = fakeGit(on, { [STATUS]: { stdout: `${CLEAN}1 M. N... ${H} src/a.ts\u0000` } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'commit' })
  expect(git.calls.filter(call => call.startsWith('git commit'))).toEqual([])
  expect(git.toasts).toContain('Commit message is empty')
  await ui.unmount()
})

test('commit with nothing staged stages tracked changes first', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: `${CLEAN}1 .M N... ${H} src/a.ts\u0000` },
    'git commit -m msg': { stdout: '[main 1a2b3c4] msg' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'message', text: 'msg' })
  const add = git.calls.indexOf('git add -u')
  expect(add).toBeGreaterThan(-1)
  expect(git.calls.indexOf('git commit -m msg')).toBeGreaterThan(add)
  await ui.unmount()
})

test('commit with nothing to commit reports it', async ($, on) => {
  const git = fakeGit(on, { [STATUS]: { stdout: CLEAN } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'message', text: 'msg' })
  expect(git.calls.filter(call => call.startsWith('git commit'))).toEqual([])
  expect(git.toasts).toContain('Nothing to commit')
  await ui.unmount()
})

test('first commit in a repo with hooks says so', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: `${CLEAN}1 M. N... ${H} src/a.ts\u0000` },
    'git config --get core.hooksPath': { stdout: '.githooks\u0000' },
    'git commit -m one': { stdout: '[main 1111111] one' },
    'git commit -m two': { stdout: '[main 2222222] two' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'message', text: 'one' })
  expect(git.toasts).toContain('Committed 1111111 (repo hooks skipped)')
  await ui.input({ key: 'message', text: 'two' })
  expect(git.toasts).toContain('Committed 2222222')
  await ui.unmount()
})

test('push without upstream retries with set-upstream', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: '# branch.head feat\u0000' },
    'git push': { exitCode: 128, stderr: 'fatal: The current branch feat has no upstream branch.' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'push' })
  expect(git.calls).toContain('git push --set-upstream origin feat')
  expect(git.toasts).toContain('Pushed')
  await ui.unmount()
})

test('push failure shows the first stderr line', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: CLEAN },
    'git push': { exitCode: 1, stderr: '! [rejected] main -> main\nerror: failed to push' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'push' })
  expect(git.toasts).toContain('! [rejected] main -> main')
  expect(await ui.find({ type: 'Text', text: /rejected/ })).toBe(undefined)
  await ui.unmount()
})

test('branch select checks out, + New branch shows the input and Cancel returns', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: CLEAN },
    'git branch --format=%(refname:short)': { stdout: 'main\ndev\n' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'branch', value: 'dev' })
  expect(git.calls).toContain('git checkout dev')
  await ui.select({ key: 'branch', value: '__new__' })
  expect(await ui.find({ type: 'Input', key: 'new-branch' })).toBeDefined()
  await ui.press({ key: 'new-branch-cancel' })
  expect(await ui.find({ type: 'Input', key: 'new-branch' })).toBe(undefined)
  expect(await ui.find({ type: 'Select', key: 'branch' })).toBeDefined()
  await ui.select({ key: 'branch', value: '__new__' })
  await ui.input({ key: 'new-branch', text: ' feat/x ' })
  expect(git.calls).toContain('git checkout -b feat/x')
  expect(await ui.find({ type: 'Select', key: 'branch' })).toBeDefined()
  await ui.unmount()
})

test('long list is cut with the overflow line', async ($, on) => {
  const lines = Array.from({ length: 20 }, (_, i) => `1 .M N... ${H} src/file${i}.ts`).join('\u0000')
  fakeGit(on, { [STATUS]: { stdout: `${CLEAN}${lines}\u0000` } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 14 } }, surface: 'desktop' })
  const more = await ui.find({ type: 'Text', text: /… and \d+ more/ })
  expect(more?.text).toBe('… and 14 more')
  await ui.unmount()
})

test('a value with an old shape tag is declined', async ($, on) => {
  on('state.get', () => ({
    value: { value: { branch: 'old', staged: [{ path: 'x', code: 'M' }], unstaged: [] }, version: 1 },
  }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No changes/ }))?.text).toBe('No changes')
  expect(await ui.find({ type: 'Text', text: /old/ })).toBe(undefined)
  await ui.unmount()
})

test('commit button uses the latest typed draft, not the drawn one', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: `${CLEAN}1 M. N... ${H} src/a.ts\u0000` },
    'git commit -m latest': { stdout: '[main 1a2b3c4] latest' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'message', text: 'latest', kind: 'change' })
  await ui.press({ key: 'commit' })
  expect(git.calls).toContain('git commit -m latest')
  await ui.unmount()
})

test('commit refreshes status before deciding to stage', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: [{ stdout: CLEAN }, { stdout: `${CLEAN}1 M. N... ${H} src/a.ts\u0000` }],
    'git commit -m msg': { stdout: '[main 1a2b3c4] msg' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'message', text: 'msg' })
  expect(git.calls).not.toContain('git add -u')
  expect(git.calls).toContain('git commit -m msg')
  await ui.unmount()
})

test('mounting the pane starts the refresh timer when none runs', async ($, on) => {
  const git = fakeGit(on, { [STATUS]: { stdout: CLEAN } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = git.calls.filter(call => call === STATUS).length
  await git.clock.advance(3000)
  expect(git.calls.filter(call => call === STATUS).length).toBe(before + 1)
  await ui.unmount()
})

test('detached head is drawn as text and is not a branch option', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: '# branch.oid abc\u0000# branch.head (detached)\u0000' },
    'git branch --format=%(refname:short)': { stdout: 'main\n' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const select = await ui.find({ type: 'Select', key: 'branch' })
  const options = select?.props.options as Array<{ value: string }>
  expect(options.map(option => option.value)).toEqual(['main', '__new__'])
  expect((await ui.find({ type: 'Text', text: /\(detached\)/ }))?.text).toBe('(detached)')
  await ui.press({ key: 'push' })
  expect(git.calls).toContain('git push')
  await ui.unmount()
})

test('selecting the current branch runs no checkout', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: CLEAN },
    'git branch --format=%(refname:short)': { stdout: 'main\ndev\n' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'branch', value: 'main' })
  expect(git.calls.filter(call => call.startsWith('git checkout'))).toEqual([])
  await ui.unmount()
})

test('files are grouped under directory rows and show their base name', async ($, on) => {
  fakeGit(on, {
    [STATUS]: {
      stdout: `${CLEAN}1 .M N... ${H} docs/specs/design.md\u00001 .M N... ${H} docs/specs/plan.md\u00001 .M N... ${H} src/a.ts\u0000? README.md\u0000`,
    },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'dir:unstaged:docs/specs' }))?.text).toBe('▾ docs/specs')
  expect((await ui.find({ type: 'Button', key: 'dir:unstaged:src' }))?.text).toBe('▾ src')
  expect((await ui.find({ type: 'Button', key: 'open:docs/specs/design.md' }))?.text).toBe('design.md')
  expect((await ui.find({ type: 'Button', key: 'open:README.md' }))?.text).toBe('README.md')
  expect(await ui.findAll({ type: 'Button', key: 'dir:unstaged:docs/specs' })).toHaveLength(1)
  await ui.unmount()
})

test('directory rows collapse and expand their files', async ($, on) => {
  fakeGit(on, {
    [STATUS]: { stdout: `${CLEAN}1 .M N... ${H} docs/specs/design.md\u00001 .M N... ${H} docs/specs/plan.md\u00001 .M N... ${H} src/a.ts\u0000` },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'open:docs/specs/design.md' })).toBeDefined()
  await ui.press({ key: 'dir:unstaged:docs/specs' })
  expect(await ui.find({ type: 'Button', key: 'open:docs/specs/design.md' })).toBe(undefined)
  expect(await ui.find({ type: 'Button', key: 'open:docs/specs/plan.md' })).toBe(undefined)
  expect(await ui.find({ type: 'Button', key: 'open:src/a.ts' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^Changes/ }))?.text).toBe('Changes (3)')
  await ui.press({ key: 'dir:unstaged:docs/specs' })
  expect(await ui.find({ type: 'Button', key: 'open:docs/specs/design.md' })).toBeDefined()
  await ui.unmount()
})

const DIFF = 'git --no-optional-locks diff --no-color --no-ext-diff'
const HUNK = '@@ -1,2 +1,2 @@\n one\n-two\n+three'
const PATCH = `diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n${HUNK}\n`

test('terminal: path click draws the diff in the pane, Back returns to the list', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: `${CLEAN}1 .M N... ${H} src/a.ts\u0000` },
    [`${DIFF} -- src/a.ts`]: { stdout: PATCH },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'open:src/a.ts' })
  expect(git.mcp).toEqual([])
  const code = await ui.find({ type: 'Code' })
  expect(code?.props.source).toBe(HUNK)
  expect(code?.props.format).toBe('diff')
  expect(await ui.find({ type: 'Button', key: 'open:src/a.ts' })).toBe(undefined)
  await ui.press({ key: 'diff-back' })
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
  expect(await ui.find({ type: 'Button', key: 'open:src/a.ts' })).toBeDefined()
  await ui.unmount()
})

test('terminal: staged and untracked files read their own diff', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: `${CLEAN}1 M. N... ${H} src/a.ts\u0000? new.md\u0000` },
    [`${DIFF} --cached -- src/a.ts`]: { stdout: PATCH },
    [`${DIFF} --no-index -- /dev/null new.md`]: { exitCode: 1, stdout: '--- /dev/null\n+++ b/new.md\n@@ -0,0 +1 @@\n+hello\n' },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'open:src/a.ts' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(HUNK)
  expect(await ui.find({ type: 'Button', key: 'diff-unstage' })).toBeDefined()
  await ui.press({ key: 'diff-back' })
  await ui.press({ key: 'open:new.md' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -0,0 +1 @@\n+hello')
  expect(git.toasts).toEqual([])
  await ui.unmount()
})

test('terminal: an empty diff stays on the list and says so; a diff that empties closes', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: `${CLEAN}1 .M N... ${H} src/a.ts\u00001 .M N... ${H} src/b.ts\u0000` },
    [`${DIFF} -- src/a.ts`]: { stdout: '' },
    [`${DIFF} -- src/b.ts`]: [{ stdout: PATCH.replaceAll('a.ts', 'b.ts') }, { stdout: '' }],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'open:src/a.ts' })
  expect(git.toasts).toContain('No changes in src/a.ts')
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
  await ui.press({ key: 'open:src/b.ts' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.press({ key: 'diff-stage' })
  expect(git.calls).toContain('git add -- src/b.ts')
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
  await ui.unmount()
})

test('an untracked directory is a row named after itself, not a group with a blank file', async ($, on) => {
  const git = fakeGit(on, { [STATUS]: { stdout: `${CLEAN}? var/\u0000? src/new/\u0000` } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'open:var/' }))?.text).toBe('var/')
  expect((await ui.find({ type: 'Button', key: 'open:src/new/' }))?.text).toBe('new/')
  expect(await ui.find({ type: 'Button', key: 'dir:unstaged:var' })).toBe(undefined)
  expect(await ui.find({ type: 'Button', key: 'dir:unstaged:src' })).toBeDefined()
  await ui.press({ key: 'open:var/' })
  expect(git.toasts).toContain('var/ is an untracked directory')
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
  await ui.unmount()
})

test('terminal: hidden lines around hunks expand 100 at a time', async ($, on) => {
  const file = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`)
  file[149] = 'changed 150'
  file[299] = 'changed 300'
  const patch = [
    '--- a/big.txt', '+++ b/big.txt',
    '@@ -150,1 +150,1 @@', '-line 150', '+changed 150',
    '@@ -300,1 +300,1 @@', '-line 300', '+changed 300', '',
  ].join('\n')
  const git = fakeGit(
    on,
    { [STATUS]: { stdout: `${CLEAN}1 .M N... ${H} big.txt\u0000` }, [`${DIFF} -- big.txt`]: { stdout: patch } },
    true,
    { 'big.txt': `${file.join('\n')}\n` },
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'open:big.txt' })
  expect((await ui.find({ type: 'Button', key: 'expand:0' }))?.text).toBe('⋯ Show 100 of 149 hidden lines')
  expect((await ui.find({ type: 'Button', key: 'expand:1' }))?.text).toBe('⋯ Show 100 of 149 hidden lines')
  expect((await ui.find({ type: 'Button', key: 'expand:2' }))?.text).toBe('⋯ Show 100 of 100 hidden lines')

  await ui.press({ key: 'expand:0' })
  expect((await ui.find({ type: 'Button', key: 'expand:0' }))?.text).toBe('⋯ Show 49 of 49 hidden lines')
  const top = String((await ui.findAll({ type: 'Code' }))[0]?.props.source).split('\n')
  expect(top.slice(0, 2)).toEqual(['@@ -50,101 +50,101 @@', ' line 50'])
  expect(top.slice(-3)).toEqual([' line 149', '-line 150', '+changed 150'])

  await ui.press({ key: 'expand:1' })
  const grown = String((await ui.findAll({ type: 'Code' }))[0]?.props.source).split('\n')
  expect(grown[0]).toBe('@@ -50,201 +50,201 @@')
  expect(grown.slice(-1)).toEqual([' line 250'])
  expect((await ui.find({ type: 'Button', key: 'expand:1' }))?.text).toBe('⋯ Show 49 of 49 hidden lines')

  await ui.press({ key: 'expand:2' })
  expect(await ui.find({ type: 'Button', key: 'expand:2' })).toBe(undefined)
  const last = String((await ui.findAll({ type: 'Code' }))[1]?.props.source).split('\n')
  expect(last[0]).toBe('@@ -300,101 +300,101 @@')
  expect(last.slice(-1)).toEqual([' line 400'])
  expect(git.toasts).toEqual([])
  await ui.unmount()
})

const ROOT = 'git rev-parse --show-toplevel'

const SPLIT = `tmux split-window -h -t %3 -c /repo sh -c ${EDIT_SCRIPT} edit`

test('terminal inside tmux: the file icon opens nano in a split at the first changed line', async ($, on) => {
  const git = fakeGit(
    on,
    {
      [STATUS]: { stdout: `${CLEAN}1 .M N... ${H} src/a.ts\u00001 M. N... ${H} src/b.ts\u0000? new.md\u0000` },
      [ROOT]: { stdout: '/repo\n' },
      [`${DIFF} -U0 -- src/a.ts`]: { stdout: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -40 +42,2 @@\n-x\n+y\n+z\n' },
      [`${DIFF} -U0 --cached -- src/b.ts`]: { stdout: '@@ -7,2 +6,0 @@\n-x\n-y\n' },
      [`${DIFF} -- src/a.ts`]: { stdout: PATCH },
    },
    true,
    {},
    { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3' },
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'file:src/a.ts' })
  await ui.press({ key: 'file:src/b.ts' })
  await ui.press({ key: 'file:new.md' })
  await ui.press({ key: 'open:src/a.ts' })
  await ui.press({ key: 'diff-file' })
  expect(git.calls.filter(call => call.startsWith('tmux'))).toEqual([
    `${SPLIT} ./src/a.ts 42`,
    `${SPLIT} ./src/b.ts 6`,
    `${SPLIT} ./new.md 1`,
    `${SPLIT} ./src/a.ts 42`,
  ])
  expect(git.mcp).toEqual([])
  expect(git.toasts).toEqual([])
  await ui.unmount()
})

test('terminal outside tmux: the file icon opens VS Code, and says so when that fails', async ($, on) => {
  const git = fakeGit(on, {
    [STATUS]: { stdout: `${CLEAN}? new.md\u0000` },
    [ROOT]: { stdout: '/repo\n' },
    'code -g /repo/new.md:1': [{}, { exitCode: 127, stderr: 'code: command not found' }],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'file:new.md' })
  expect(git.calls).toContain('code -g /repo/new.md:1')
  expect(git.toasts).toEqual([])
  await ui.press({ key: 'file:new.md' })
  expect(git.toasts).toEqual(['No editor: start Claude inside tmux, or install the `code` command'])
  await ui.unmount()
})
