# T3 Code for VS Code

T3 Code in a VS Code tab, locked to the folder you have open. You see only that folder's project and its threads, and new threads always start there. Two windows on two folders stay separate.

## Requirements

- The T3 Code desktop app, installed and running on the same Mac.
- A local folder. Remote windows (SSH, containers, WSL) aren't supported yet.

## Getting started

1. Open a folder in VS Code.
2. Open T3 Code from the T3 Code icon in the activity bar, the **T3 Code** item in the status bar, or **T3 Code: Open** in the Command Palette.
3. The first time, VS Code asks to connect to the desktop app. It uses the app's command-line tool to create its own sign-in, like pairing another device, and remembers your answer.

The first time you open a folder, T3 Code adds it as a project. In a multi-root workspace, T3 Code asks which folder to open, and each folder gets its own tab.

## Commands

- **T3 Code: Open** opens T3 Code for a folder in this window.
- **T3 Code: Reload** reloads the T3 Code tab.
- **T3 Code: Connect to the Desktop App** pairs again, automatically or with a pairing link or token you paste.
- **T3 Code: Disconnect** closes T3 Code, forgets VS Code's sign-in and asks again before the next pairing. The session stays listed in the desktop app until you revoke it there.

## Settings

- `t3code.homeDir`: the T3 Code data directory, if you changed it from the default (`T3CODE_HOME` or `~/.t3`).
- `t3code.desktopAppPath`: where the desktop app is installed, if it isn't in `/Applications` or `~/Applications`.
- `t3code.serverCommand`: a command that runs the T3 Code server CLI, for setups without the desktop app.

## Troubleshooting

- **"The T3 Code desktop app isn't running."** Start the desktop app, then choose **Retry**.
- **A version warning.** The extension ships its own copy of the T3 Code interface. When the desktop app has a different version, most things keep working; update both if something looks wrong.
- **VS Code shortcuts don't work inside the tab.** Keyboard focus belongs to T3 Code while you type in it. Click outside the tab to use VS Code shortcuts.
- **Drafts and layout differ per folder.** Each folder keeps its own T3 Code interface state.
