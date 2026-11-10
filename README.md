# Claude Code mods

Two mods for Claude Code. Each installs on its own.

| Mod | What it does |
| --- | --- |
| `source-control` | Source Control pane beside the chat: staged and unstaged files, stage, unstage, discard, commit, push, switch or create branches, diff of a file. |
| `tmux-sessions` | One row above the prompt listing the Claude Code sessions in the same tmux session, with a status dot. A click focuses that session's tmux pane. |

## Install

From a local folder (unzipped copy or a clone). Keep the folder where it is: Claude Code reads the mods from it.

```
claude plugin marketplace add /path/to/claude-code-mods
claude plugin install source-control@claude-code-mods
claude plugin install tmux-sessions@claude-code-mods
```

From GitHub:

```
claude plugin marketplace add cepauskas/claude-code-mods
claude plugin install source-control@claude-code-mods
claude plugin install tmux-sessions@claude-code-mods
```

Then restart Claude Code, or run `/reload-plugins` in every open session.

Remove: `claude plugin uninstall source-control@claude-code-mods`, `claude plugin uninstall tmux-sessions@claude-code-mods`.

## source-control

- Open the pane with `/source-control` or the `⎇` button above the prompt.
- Desktop app: a click on a file opens the app's diff pane.
- Terminal: a click on a file draws the diff inside the pane. Hidden lines around each change expand 100 at a time. `← Back` returns to the file list.
- The open-file icon (`↗`) on the terminal runs `nano` in a tmux split when Claude Code runs inside tmux; the split closes on save or exit. Outside tmux it runs `code -g` (the VS Code command line tool).

## tmux-sessions

- The row shows only when Claude Code runs inside tmux and another Claude Code session runs in the same tmux session.
- Dot colours: yellow busy, green idle, red any other status (named in brackets).
- A click needs the fullscreen terminal layout and `set -g mouse on` in `~/.tmux.conf`.
- The list is read from `~/.claude/sessions/<pid>.json`, which Claude Code keeps for itself and does not document. A Claude Code update can break the mod.

## Limits

- Tested on macOS only.
- Both mods draw in the band above the prompt and share one rule line above it; either works without the other.

## Develop

Each mod folder has its tests: `claude plugin test <mod folder>`. Check a mod with `claude plugin validate <mod folder>`.
