# Contributing

`npm test` must pass before a pull request. CI runs the build and tests on Node 22 and 24 and enforces that no absolute user paths are committed.

Use the [source setup](getting-started.md#setup). Unit tests preload `test/fixtures/foundation/test-env.mjs` to isolate state and personal skills. Without the preload, config detects `NODE_TEST_CONTEXT` and uses a fresh temporary state root when `ROUNDTABLE_HOME` is unset, warning once on stderr. This fallback is a last guard; the preload also cleans up and isolates other paths.

The offline suite uses stubbed providers and stdio smoke tests. Loopback-listener and platform sandbox tests require permissions unavailable in some development sandboxes. The real Chrome test and live-provider checks are opt-in; see the test flags in [configuration](configuration.md#test-and-internal-environment).
