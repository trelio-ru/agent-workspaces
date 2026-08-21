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

Production publication is intentionally a separate guarded step from an
up-to-date Trelio checkout. The first command is read-only and returns a plan
digest; the second must repeat the exact digest after operator review:

```sh
node ops/scripts/publish_agent_skill_release.mjs \
  --tag skill-<skill-id>-v<skill-version> \
  --publisher-user-id <production-super-admin-user-uuid>

node ops/scripts/publish_agent_skill_release.mjs \
  --tag skill-<skill-id>-v<skill-version> \
  --publisher-user-id <production-super-admin-user-uuid> \
  --apply <exact-plan-sha256>
```

The Trelio helper downloads the artifact from the successful exact tag run;
it does not accept an arbitrary local package. Production backend revalidates
the plan and package before signing, so GitHub Actions never receives the
signing key or authority to move the current release pointer.

`release.state = planned` means that the source is ready for the named future
publication but the live backend pointer has not been changed yet. Change it to
`current` only after publication and a fresh `get_agent_skill` verification.
