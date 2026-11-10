export type SessionRow = {
  pid: number
  name: string
  status: string
  pane: string
  isSelf: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'tmux-sessions': {
      rows: Shaped<SessionRow[]>
    }
  }
}
