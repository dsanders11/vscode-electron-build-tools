# Electron Build Tools

## What Is It?

Electron Build Tools is a command-line interface (CLI) to help build Electron
from source, and has other helper commands for common development tasks. This
VS Code extension provides a deep integration of Electron's build tools into
VS Code, providing a graphical user interface (GUI) for the most common
commands, user-friendly views of tests and patches, and other handy helpers.

You can learn more about the Electron Build Tools CLI
[here](https://github.com/electron/build-tools).

## Prerequisites

A handful of prerequisites, such as Git, Node.js, and npm, are required for
building Electron itself; these can be found in [Platform Prerequisites].

Electron Build Tools is configured to use Yarn, so please
[install it to your system](https://yarnpkg.com/lang/en/docs/install/).

## Installing

For convenience, you can use the "Install Build Tools" button on this step
to install the `@electron/build-tools` package for you.

If you want to manually install it, from here on you'll need a command-line
prompt. On Mac and Linux, this will be a terminal with a shell, e.g. bash or
zsh. You can also use these on Windows if you install them, or use built-in
tools like Windows' [Command Prompt].

Please note that build tools (due to nested dependencies) might not work
properly in powershell, please use `cmd` on Windows for optimum results.

```sh
# Install build-tools package globally:
yarn global add @electron/build-tools
```

[Command Prompt]: https://docs.microsoft.com/en-us/windows-server/administration/windows-commands/windows-commands#command-shell-overview
[Platform Prerequisites]: https://electronjs.org/docs/development/build-instructions-gn#platform-prerequisites
