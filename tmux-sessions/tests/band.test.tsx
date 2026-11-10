import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fit, parseSession } from '../hooks/sessions'

const DIR = '/home/me/.claude/sessions'
const BAND = {
  plugin: 'tmux-sessions',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const file = (pid: number, name: string, status: string, tmux?: string) =>
  JSON.stringify({ pid, name, status, cwd: `/work/${name}`, ...(tmux === undefined ? {} : { tmux }) })

function fake(
  on: On,
  files: Record<string, string>,
  alive: number[],
  env: Record<string, string> = { TMUX: '/tmp/tmux,1,0', TMUX_PANE: '%0' },
  panes = ['%0', '%1', '%2', '%7'],
) {
  const calls: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  on('env.get', (_, e) => ({ value: { HOME: '/home/me', ...env }[e.name] }))
  on('fs.list', (_, e) => ({
    value: e.path === DIR ? Object.keys(files).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) : [],
  }))
  on('fs.read', (_, e) => ({ value: files[e.path.slice(DIR.length + 1)] ?? '' }))
  on('process.run', (_, e) => {
    calls.push(e.argv.join(' '))
    const isPs = e.argv[0] === 'ps'
    const isList = e.argv[1] === 'list-panes'

    return {
      value: { exitCode: 0, stdout: isPs ? alive.map(pid => `  ${pid}\n`).join('') : isList ? panes.map(id => `${id}\n`).join('') : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return { calls, toasts, clock, files }
}

const THREE = {
  '10.json': file(10, 'alpha', 'busy', '0:@0.%0'),
  '11.json': file(11, 'beta', 'idle', '0:@1.%1'),
  '12.json': file(12, 'desktop', 'idle'),
  '13.json': file(13, 'gone', 'idle', '0:@2.%2'),
  '14.json': 'not json',
  'x.key': 'secret',
}

test('lists the live tmux sessions in pane order, own one as text, others as buttons', async ($, on) => {
  const kit = fake(on, THREE, [10, 11, 12])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /alpha/ }))?.text).toBe('alpha')
  expect((await ui.find({ type: 'Button', key: 'focus:%1' }))?.text).toBe('beta')
  expect(await ui.find({ type: 'Button', key: 'focus:%0' })).toBe(undefined)
  expect(await ui.find({ type: 'Button', key: 'focus:%2' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /desktop/ })).toBe(undefined)
  expect((await ui.findAll({ type: 'Text', text: /●/ })).map(dot => dot.props.color)).toEqual(['warning', 'success'])
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(kit.calls).toEqual(['ps -o pid= -p 10,11,13', 'tmux list-panes -s -t %0 -F #{pane_id}'])
  await ui.unmount()
})

test('a click focuses the session pane in tmux', async ($, on) => {
  const kit = fake(on, THREE, [10, 11])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'focus:%1' })
  expect(kit.calls.slice(-1)).toEqual(['tmux select-window -t %1 ; select-pane -t %1'])
  expect(kit.toasts).toEqual([])
  await ui.unmount()
})

test('the timer picks up a status change and a new session', async ($, on) => {
  const kit = fake(on, { ...THREE }, [10, 11, 15])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  kit.files['11.json'] = file(11, 'beta', 'waiting', '0:@1.%1')
  kit.files['15.json'] = file(15, 'gamma', 'busy', '1:@4.%7')
  await kit.clock.advance(2000)
  expect((await ui.find({ type: 'Button', key: 'focus:%1' }))?.text).toBe('beta (waiting)')
  expect((await ui.find({ type: 'Button', key: 'focus:%7' }))?.text).toBe('gamma')
  expect((await ui.findAll({ type: 'Text', text: /●/ })).map(dot => dot.props.color)).toEqual(['warning', 'error', 'warning'])
  await ui.unmount()
})

test('draws nothing of its own outside tmux or when alone', async ($, on) => {
  const kit = fake(on, THREE, [10, 11], {})
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button' })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(kit.calls).toEqual([])
  await ui.unmount()
})

test('alone in tmux draws nothing of its own', async ($, on) => {
  fake(on, THREE, [10])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /alpha/ })).toBe(undefined)
  await ui.unmount()
})

test('a session in another tmux session is left out', async ($, on) => {
  fake(on, { ...THREE, '15.json': file(15, 'gamma', 'busy', 'other:@4.%7') }, [10, 11, 15], undefined, ['%0', '%1'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'focus:%1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'focus:%7' })).toBe(undefined)
  await ui.unmount()
})

test('parseSession keeps tmux sessions only and falls back to the folder name', async () => {
  expect(parseSession(file(1, 'a', 'idle'))).toBe(undefined)
  expect(parseSession('{"pid":"1","tmux":"0:@0.%0"}')).toBe(undefined)
  expect(parseSession('{"pid":1,"tmux":"0:@0.%3","cwd":"/work/repo"}')).toEqual({ pid: 1, pane: '%3', name: 'repo', status: 'unknown' })
})

test('fit leaves out what does not fit the row', async () => {
  const rows = ['one', 'two', 'three'].map((name, index) => ({ pid: index, name, status: 'idle', pane: `%${index}`, isSelf: false }))
  expect(fit(rows, 80).hidden).toBe(0)
  expect(fit(rows, 18)).toEqual({ shown: rows.slice(0, 2), hidden: 1 })
})
