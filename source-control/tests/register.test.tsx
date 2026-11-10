import type { On, ProcessRunResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

type Answer = Partial<ProcessRunResult>

const STATUS = 'git --no-optional-locks status --porcelain=v2 --branch -z'
const H = '100644 100644 100644 1111111 2222222'
const CLEAN = '# branch.head main\u0000'
const CHANGED = `# branch.head main\u00001 .M N... ${H} src/a.ts\u0000`

function boot(on: On, answers: Record<string, Answer | Answer[]>, isPlaced = true) {
  const calls: string[] = []
  const registered: string[] = []
  const opened: Array<{ id: string; title?: string; backgroundColor?: unknown }> = []
  const state: Record<string, unknown> = {}
  const writes: Record<string, number> = {}
  const clock = mock.clock(on)
  let isPaneFocused = true
  on('process.run', (_, e) => {
    const key = e.argv.join(' ')
    calls.push(key)
    const found = answers[key]
    const answer = Array.isArray(found) ? (found.shift() ?? {}) : (found ?? {})

    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...answer },
    }
  })
  on('state.set', (_, e, next) => {
    const raw = e.value as { shape?: string; value?: unknown } | undefined
    state[e.key] = raw !== undefined && typeof raw === 'object' && 'shape' in raw ? raw.value : raw
    writes[e.key] = (writes[e.key] ?? 0) + 1

    return next(e)
  })
  on('ui.panes', () => ({
    value: [{ id: 'source-control', title: 'Source Control', isShown: true, isFocused: isPaneFocused, isPlaced: true }],
  }))
  on('command.register', (_, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.open', (_, e) => {
    opened.push({ id: e.id, title: e.title, backgroundColor: e.backgroundColor })

    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('ui.focus', () => ({}))

  return {
    calls,
    registered,
    opened,
    clock,
    writes,
    focusPane: (flag: boolean) => {
      isPaneFocused = flag
    },
    statusCalls: () => calls.filter(call => call === STATUS).length,
    status: () => state.status as { unstaged: unknown[] } | undefined,
    ui: () => state.ui as { isStatusStale: boolean } | undefined,
  }
}

test('session start registers the command, refreshes and opens the pane', async ($, on) => {
  const git = boot(on, { [STATUS]: { stdout: CLEAN } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(git.registered).toEqual(['source-control'])
  expect(git.opened).toEqual([{ id: 'source-control', title: 'Source Control', backgroundColor: 'transparent' }])
  expect(git.statusCalls()).toBe(1)
})

test('the timer refreshes every 3 s while the pane is placed', async ($, on) => {
  const git = boot(on, { [STATUS]: { stdout: CLEAN } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await git.clock.advance(9000)
  expect(git.statusCalls()).toBe(4)
})

test('no timer while the pane is not placed', async ($, on) => {
  const git = boot(on, { [STATUS]: { stdout: CLEAN } }, false)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await git.clock.advance(9000)
  expect(git.statusCalls()).toBe(1)
})

test('a finished Edit tool call triggers a refresh, a Read does not', async ($, on) => {
  const git = boot(on, { [STATUS]: { stdout: CLEAN } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'x', new_string: 'y' })
  await git.clock.advance(0)
  expect(git.statusCalls()).toBe(2)
  await $.tool.call({ tool: 'Read', file_path: '/a.ts' })
  await git.clock.advance(0)
  expect(git.statusCalls()).toBe(2)
})

test('focus on the message input pauses timer writes and blur applies them', async ($, on) => {
  const git = boot(on, { [STATUS]: [{ stdout: CLEAN }, { stdout: CHANGED }, { stdout: CHANGED }] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.ui.focus({ component: 'Pane', requestId: 'source-control', element: 'message', origin: { kind: 'person' } })
  await git.clock.advance(3000)
  expect(git.status()?.unstaged).toEqual([])
  expect(git.ui()?.isStatusStale ?? false).toBe(false)
  await $.ui.focus({ component: 'Pane', requestId: 'source-control', element: 'commit', origin: { kind: 'person' } })
  await git.clock.advance(0)
  expect(git.status()?.unstaged).toEqual([{ path: 'src/a.ts', code: 'M' }])
  expect(git.ui()?.isStatusStale ?? false).toBe(false)
})

test('/source-control reopens the pane', async ($, on) => {
  const git = boot(on, { [STATUS]: { stdout: CLEAN } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ command: 'source-control', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(result.text).toBe('Source Control pane opened.')
  expect(git.opened).toHaveLength(2)
})

test('typing in the message field does not pause refresh when the pane has no keyboard focus', async ($, on) => {
  const git = boot(on, { [STATUS]: [{ stdout: CLEAN }, { stdout: CHANGED }] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.ui.focus({ component: 'Pane', requestId: 'source-control', element: 'message', origin: { kind: 'person' } })
  git.focusPane(false)
  await git.clock.advance(3000)
  expect(git.status()?.unstaged).toEqual([{ path: 'src/a.ts', code: 'M' }])
})

test('timer ticks with an unchanged tree write no state', async ($, on) => {
  const git = boot(on, { [STATUS]: { stdout: CHANGED } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const status = git.writes.status ?? 0
  const ui = git.writes.ui ?? 0
  await git.clock.advance(6000)
  expect(git.statusCalls()).toBe(3)
  expect(git.writes.status ?? 0).toBe(status)
  expect(git.writes.ui ?? 0).toBe(ui)
})

test('a refresh failure shows status unavailable and a later success clears it', async ($, on) => {
  const git = boot(on, { [STATUS]: [{ stdout: CLEAN }, { exitCode: 1, stderr: 'index.lock' }, { stdout: CLEAN }] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await git.clock.advance(3000)
  expect(git.ui()?.isStatusStale).toBe(true)
  await git.clock.advance(3000)
  expect(git.ui()?.isStatusStale).toBe(false)
})

const BAND = {
  plugin: 'source-control',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

test('the band offers a Source Control button while the pane is not shown', async ($, on) => {
  const git = boot(on, { [STATUS]: { stdout: CLEAN } }, false)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const hidden = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const button = await hidden.find({ type: 'Button', key: 'open-source-control' })
  expect(button?.text).toBe('⎇ Git')
  expect(button?.props.label).toBe('Source Control')
  expect((await hidden.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await hidden.press({ key: 'open-source-control' })
  expect(git.opened).toHaveLength(2)
  await hidden.unmount()
})

test('the band keeps the Source Control button while the pane is placed', async ($, on) => {
  boot(on, { [STATUS]: { stdout: CLEAN } })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const shown = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await shown.find({ type: 'Button', key: 'open-source-control' }))?.text).toBe('⎇ Git')
  expect((await shown.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await shown.unmount()
})

test('the band draws one rule above its row and drops the rule of the mods beneath', async ($, on) => {
  boot(on, { [STATUS]: { stdout: CLEAN } }, false)
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box key="inner" flexDirection="column">
        <Box key="band-rule">
          <Text>inner rule</Text>
        </Box>
        <Text>tabs</Text>
      </Box>
    )
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.findAll({ type: 'Box', key: 'band-rule' })).toHaveLength(1)
  expect(await band.find({ type: 'Text', text: /inner rule/ })).toBe(undefined)
  expect((await band.find({ type: 'Text', text: /tabs/ }))?.text).toBe('tabs')
  expect((await band.find({ type: 'Text', text: /─/ }))?.text).toBe('─'.repeat(80))
  await band.unmount()
})
