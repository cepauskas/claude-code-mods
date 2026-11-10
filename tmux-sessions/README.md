# tmux-sessions

One row above the prompt listing the Claude Code sessions that run inside tmux.
A dot shows each session's status (yellow busy, green idle, red anything else, named in brackets).
A click on a name focuses that session's tmux window and pane. Only sessions of the same tmux session are listed. The row is drawn only inside tmux and only when another session exists.

The list comes from the engine's own session registry, `~/.claude/sessions/<pid>.json`. That registry is undocumented; a Claude Code update can change it.

Install: see the README one folder up. Tests: `claude plugin test .`.
