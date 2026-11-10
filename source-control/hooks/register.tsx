import type { EngineInterface, Register } from 'claude-code'

import { refresh, setMessageFocused, startTimer, stopTimer, takeDeferredRefresh } from './actions'
import { renderBand } from './band'
import { renderPane } from './pane'
import { PANE, PANE_TITLE } from './state'

const EDITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash'])

async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, backgroundColor: 'transparent' })
  if (opened.isPlaced) {
    startTimer($)
  } else {
    stopTimer()
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'source-control', description: 'Open the Source Control pane' })
    await refresh($, { force: true })
    await openPane($)

    return next(e)
  })

  on('command.run', { command: 'source-control' }, async $ => {
    await refresh($, { force: true })
    await openPane($)

    return { text: 'Source Control pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: 'source-control' }, ($, e) => renderPane($, e))

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => renderBand($, e, () => void openPane($), next))

  on('ui.close', { id: 'source-control' }, async ($, e, next) => {
    stopTimer()

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (EDITING_TOOLS.has(String(e.tool))) {
      void refresh($)
    }

    return ran
  })

  on('ui.focus', { component: 'Pane', requestId: 'source-control' }, ($, e, next) => {
    const isMessage = e.element === 'message'
    setMessageFocused(isMessage)
    if (!isMessage && takeDeferredRefresh()) {
      void refresh($, { force: true })
    }

    return next(e)
  })
}
