# Platform skills

This directory is the canonical source and independent release contour for
provider-specific Agent Skills. Provider instructions, executable code, tests
and release metadata live here, never in the `trelio-agent-workspaces` plugin
bundle.

Each publishable runtime owns a `release.json` file. It records the next or
current skill version, the immutable runtime version, the oldest compatible
generic host and the exact package inputs. Build a package without writing an
artifact:

```sh
node platform-skills/tools/build-runtime-package.mjs \
  --skill-dir platform-skills/telegram-web \
  --check
```

Build the exact upload artifact only when preparing a backend publication:

```sh
node platform-skills/tools/build-runtime-package.mjs \
  --skill-dir platform-skills/telegram-web \
  --output /absolute/path/telegram-web-2.0.1.skillpkg
```

The backend signs accepted package bytes. A skill tag has the independent form
`skill-<skill-id>-v<skill-version>` and makes CI retain the deterministic
`.skillpkg` as a workflow artifact. It does not create or update a plugin
marketplace release.

`release.state = planned` means that the source is ready for the named future
publication but the live backend pointer has not been changed yet. Change it to
`current` only after publication and a fresh `get_agent_skill` verification.
