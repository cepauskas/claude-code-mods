import { expect, test } from 'claude-code/testing'

import { EDIT_SCRIPT, argv, fitDiff, isNoUpstreamError, parseBranches, parseStatus } from '../hooks/git'

const H = '100644 100644 100644 1111111 2222222'
const Z = '\u0000'

test('parses branch header with upstream and counts', async () => {
  const status = parseStatus(['# branch.oid abc','# branch.head main','# branch.upstream origin/main','# branch.ab +2 -1',''].join(Z), 5)
  expect(status.branch).toBe('main')
  expect(status.upstream).toBe('origin/main')
  expect(status.ahead).toBe(2)
  expect(status.behind).toBe(1)
  expect(status.readAt).toBe(5)
  expect(status.isRepo).toBe(true)
})

test('detached head and initial commit', async () => {
  const status = parseStatus(['# branch.oid (initial)','# branch.head (detached)',''].join(Z), 0)
  expect(status.branch).toBe('(detached)')
  expect(status.upstream).toBe(undefined)
  expect(status.ahead).toBe(0)
  expect(status.behind).toBe(0)
})

test('splits staged and unstaged, keeping paths with spaces whole', async () => {
  const status = parseStatus(
    ['# branch.head main', `1 M. N... ${H} src/a.ts`, `1 .M N... ${H} src/b.ts`, `1 MM N... ${H} src/c d.ts`, ''].join(Z),
    0,
  )
  expect(status.staged).toEqual([
    { path: 'src/a.ts', code: 'M' },
    { path: 'src/c d.ts', code: 'M' },
  ])
  expect(status.unstaged).toEqual([
    { path: 'src/b.ts', code: 'M' },
    { path: 'src/c d.ts', code: 'M' },
  ])
})

test('rename carries the original path in the following NUL record', async () => {
  const status = parseStatus(['# branch.head main', `2 R. N... ${H} R100 new name.ts`, 'old.ts', `1 .M N... ${H} after.ts`, ''].join(Z), 0)
  expect(status.staged).toEqual([{ path: 'new name.ts', origPath: 'old.ts', code: 'R' }])
  expect(status.unstaged).toEqual([{ path: 'after.ts', code: 'M' }])
})

test('untracked, unmerged and raw non-ASCII or quoted paths', async () => {
  const status = parseStatus(['# branch.head main', '? docs/ü.md', 'u UU N... 100644 100644 100644 100644 1 2 3 both.ts', '! ignored.log', '? has"quote.txt', ''].join(Z), 0)
  expect(status.unstaged).toEqual([
    { path: 'docs/ü.md', code: 'U' },
    { path: 'both.ts', code: 'C' },
    { path: 'has"quote.txt', code: 'U' },
  ])
  expect(status.staged).toEqual([])
})

test('added and deleted codes', async () => {
  const status = parseStatus(['# branch.head main', `1 A. N... ${H} new.ts`, `1 .D N... ${H} gone.ts`, ''].join(Z), 0)
  expect(status.staged).toEqual([{ path: 'new.ts', code: 'A' }])
  expect(status.unstaged).toEqual([{ path: 'gone.ts', code: 'D' }])
})

test('parseBranches trims and drops empty lines', async () => {
  expect(parseBranches('main\nfeature/x\n\n  dev  \n')).toEqual(['main', 'feature/x', 'dev'])
})

test('unstage argv includes origPath for a rename', async () => {
  expect(argv.unstage({ path: 'n', origPath: 'o', code: 'R' })).toEqual(['git', 'restore', '--staged', '--', 'n', 'o'])
  expect(argv.unstage({ path: 'n', code: 'M' })).toEqual(['git', 'restore', '--staged', '--', 'n'])
})

test('commit argv keeps the message as one element with newlines', async () => {
  expect(argv.commit('title\n\nbody')).toEqual(['git', 'commit', '-m', 'title\n\nbody'])
})

test('status argv uses no optional locks and porcelain v2', async () => {
  expect(argv.status()).toEqual(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z'])
  expect(argv.branches()).toEqual(['git', 'branch', '--format=%(refname:short)'])
  expect(argv.stage('a b')).toEqual(['git', 'add', '--', 'a b'])
  expect(argv.stageAll()).toEqual(['git', 'add', '-A'])
  expect(argv.unstageAll()).toEqual(['git', 'restore', '--staged', '--', '.'])
  expect(argv.stageTracked()).toEqual(['git', 'add', '-u'])
  expect(argv.push()).toEqual(['git', 'push'])
  expect(argv.pushSetUpstream('feat')).toEqual(['git', 'push', '--set-upstream', 'origin', 'feat'])
  expect(argv.checkout('dev')).toEqual(['git', 'checkout', 'dev'])
  expect(argv.createBranch('x')).toEqual(['git', 'checkout', '-b', 'x'])
  expect(argv.discardTracked('p')).toEqual(['git', 'checkout', '--', 'p'])
  expect(argv.discardUntracked('p')).toEqual(['git', 'clean', '-f', '--', 'p'])
})

test('isNoUpstreamError', async () => {
  expect(isNoUpstreamError('fatal: The current branch x has no upstream branch.\n')).toBe(true)
  expect(isNoUpstreamError('fatal: There is no upstream branch for x')).toBe(true)
  expect(isNoUpstreamError('! [rejected] main -> main (fetch first)')).toBe(false)
})

test('fitDiff drops the file header and keeps whole hunks', async () => {

  const raw = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9 +9 @@\n-d\n+e\n'
  expect(fitDiff(raw, 1000)).toEqual({ text: '@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9 +9 @@\n-d\n+e', hiddenLines: 0 })
})

test('fitDiff recounts a hunk cut short and drops a header left alone', async () => {

  const raw = '@@ -1,3 +1,3 @@ fn\n a\n-b\n+c\n d\n@@ -9 +9 @@\n-d\n+e\n'
  expect(fitDiff(raw, 27)).toEqual({ text: '@@ -1,2 +1,1 @@ fn\n a\n-b', hiddenLines: 5 })
  expect(fitDiff(raw, 45)).toEqual({ text: '@@ -1,3 +1,3 @@ fn\n a\n-b\n+c\n d', hiddenLines: 3 })
})

test('fitDiff leaves output without hunks as it is', async () => {

  expect(fitDiff('Binary files a/x and b/x differ\n', 1000)).toEqual({ text: 'Binary files a/x and b/x differ', hiddenLines: 0 })
})

test('the edit script holds no `&;`, which sh refuses', async () => {
  expect(EDIT_SCRIPT.includes('&;')).toBe(false)
  expect(EDIT_SCRIPT.split('\n')).toHaveLength(4)
})
