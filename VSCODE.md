# VS Code

## Bugs

* Icon enablement bugs in tree view: [Issue][Issue-1]
* Command enablement in command palette: [Issue][Issue-2]
* Problem matchers on Windows have issues with terminal
  wrapping: [Issue][Issue-3]
* Markdown in tree item tooltips doesn't play nicely with `resourceUri`
  (hasn't landed yet): [Issue][Issue-4]
* Activity bar icon doesn't change on first load: [Issue][Issue-5]

## Shortcomings

* `markdown.showPreview` won't jump to URL fragment
* vscode.QuickPick can't be limited to N items shown
* Can't override title or icon for command by location
  * Generally want to prefix command palette titles and have
    short-form for titles when it's an icon only
* No color in theme icon references: [Issue][Issue-6]
* Snippets are global, could use a `when`/`enablement` clause so that
  you don't pollute the global namespace with extension-specific snippets
* `TreeView.reveal` doesn't work if the tree items aren't all created,
  which would be the case when the user hasn't explored the tree yet,
  making the function substantially less useful since you can't jump to
  arbitrary tree items

[Issue-1]: https://github.com/microsoft/vscode/issues/110421
[Issue-2]: https://github.com/microsoft/vscode/issues/110420
[Issue-3]: https://github.com/microsoft/vscode/issues/85839
[Issue-4]: https://github.com/microsoft/vscode/issues/100741#issuecomment-712716142
[Issue-5]: https://github.com/microsoft/vscode/issues/110525
[Issue-6]: https://github.com/microsoft/vscode/issues/110521
