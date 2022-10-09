# Build Tools Config

Build configs define the build configuration, e.g. the path to the source
code, compile-time options, your GitHub fork, and so on.

Each build config has a unique name, chosen by you to use as a mnemonic when
switching between build configs. This is the name's only purpose, so choose
whatever you find easiest to work with - whether it's `electron`,
`6-1-x--testing`, or `chocolate-onion-popsicle`.

Each build also needs a root directory. All the source code and built files
will be stored somewhere beneath it. If you want to make multiple build types
of the same branch, you can reuse an existing root to share it between build
configs.
