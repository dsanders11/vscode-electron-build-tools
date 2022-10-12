# The Sync Command

## Initial Sync

Getting the source code is a lot more than cloning `electron/electron`.
Electron is built on top of Chromium (with Electron patches) and Node
(with more Electron patches). A source tree needs to have all of the
above **and** for their versions to be in sync with each other. Electron
uses Chromium's [Depot Tools] and [GN] for wrangling and building the code.

After creating a new config, the initial sync will perform all of these steps
and get the Electron checkout ready for building. It will take a while to
download everything and initialize it, potentially hours depending on your
internet speed, so you might want to take a caffeine break after kicking it
off. There's a handy progress bar to let you know how things are going:

TODO: Insert picture of progress bar.

## When To Use Sync

TODO:

* When switching branches

## Force Sync

An interrupted sync may leave the source tree in a bad state which will cause
future syncs to fail. To remedy this situation, you can run a force sync which
will clean up the state of the source tree before syncing.

TODO: Insert picture of force sync in command palette

[Depot Tools]: https://commondatastorage.googleapis.com/chrome-infra-docs/flat/depot_tools/docs/html/depot_tools_tutorial.html#_setting_up
[GN]: https://chromium.googlesource.com/chromium/src/tools/gn/+/48062805e19b4697c5fbd926dc649c78b6aaa138/README.md
