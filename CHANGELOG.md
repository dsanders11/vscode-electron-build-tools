# Changelog

## 0.12.2 (11-4-2024)

* fix: use new(er) patches/config.json format
* chore: remove references to goma
* fix: handle changed/deleted patches in PRs
* chore: sort test files before adding like Electron does
* fix: don't include any test regexes for run all tests
* fix: remove signal forwarding code in echo-to-socket

## 0.12.1 (10-17-2022)

* fix: correct match target in encodeNewlines
* fix: improve regex for patch files
* chore: add revealInElectronSidebar to editor/title/context
* chore: cache blob responses from GitHub
* chore: use authenticated Octokit for view PR patch
* chore: add file decorations to files in patches
* chore: run tests inside extension operation

## 0.12.0 (10-15-2022)

* feat: debug test run profile
* fix: allow clearing test profile extra args
* fix: don't show error when canceling tests refresh
* chore: get source ranges for test suites and skipped tests
* fix: handle patches with trailing info
* chore: better handle applying malformed patches
* chore: handle empty .patches files correctly
* fix: use selected target in advanced build

## 0.11.0 (10-13-2022)

* feat: build settings option for new config
* chore: validate user input for new config

## 0.10.4 (10-13-2022)

* fix: restore mocha-reporter.js in packaged extension

## 0.10.3 (10-12-2022)

* fix: restore echo-to-socket.js script in packaged extension

## 0.10.2 (10-12-2022)

* fix: don't inline module

## 0.10.1 (10-12-2022)

* fix: use correct externals value for esbuild

## 0.10.0 (10-12-2022)

* feat: use VS Code's built-in Markdown linting for links
* fix: add typescript as dependency

## 0.9.0 (10-12-2022)

* feat: use custom Mocha reporter for better testing results
* feat: add advanced build command
* feat: config and sync commands available outside workspace
* feat: pull patch diff content from GH if not found locally
* chore: more pretty names for patch directories
* chore: sort patch directories by label

## 0.8.2 (10-7-2022)

* fix: import module by absolute path

## 0.8.1 (10-7-2022)

* fix: clean release

## 0.8.0 (10-7-2022)

* feat: support VS Code testing view
* fix: update build output problem matcher
* fix: correct UI for build options settings

## 0.7.1 (10-5-2022)

* fix: clean release

## 0.7.0 (10-5-2022)

* chore: bump VS Code engine version
* fix: specify --root when calling `e init`

## 0.6.1 (9-29-2022)

* chore: show downloading Xcode state in build progress notification
* fix: `e show outdir` -> `e show out --path`
* build: update prettier
* chore: remove chokidar dependency

## 0.6.0 (9-28-2022)

* chore: remove `build-tools` executable setting
* chore: remove tests support
* feat: create new config functionality
* fix: handle no configs case

## 0.5.0 (11-24-2020)

* chore: include images in docs relative link completions
* feat: markdown commands to wrap lines and rewrap selections
* feat: reveal patch in Electron sidebar

## 0.4.0 (11-23-2020)

* feat: quick search for docs
* feat: autocomplete for relative links in docs
* fix: don't try to lint empty links
* fix: ensure the active config is marked
* feat: formatter for GN files
* feat: provide links in GN files
* feat: setting to enable/disable docs linting
* feat: copy URL fragment to clipboard for Markdown header
* feat: show URL fragment on hover for Markdown header

## 0.3.0 (11-18-2020)

* fix: don't lint absolute links in docs for now
* feat: include extension for viewing GN files
* feat: show running state for all tests in test suite
* feat: cache configs for snappier UI
* feat: store tests list for snappier UI
* feat: add TODO note snippets
* feat: snippets for tests
* fix: more robust regex for patched files
* feat: add collapse all button to certain views
* feat: reveal PR tree item when viewing patches in PR
* fix: disable canceling sync operation
* feat: show incremental progress for sync

## 0.2.2 (11-12-2020)

* chore: swap activity bar icon for better one

## 0.2.1 ((11-12-2020))

* feat: color on test result icons

## 0.2.0 (11-12-2020)

* feat: view patches in pull requests

## 0.1.11 (11-11-2020)

### Fixes

* fix: don't lint non-Markdown documents for links

## 0.1.10 (11-11-2020)

First publicly advertised release.
