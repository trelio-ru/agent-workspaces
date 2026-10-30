import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {policy, read} from '@trelio/git-coordinator/coordinator';
test('current repository uses the pinned common coordinator and refuses forged main admission', () => {
  const config = policy(process.cwd());
  assert.equal(config.schemaVersion, 1);
  assert.deepEqual(config.verify, ['node', 'scripts/verify-integration-ci.mjs']);
  const sha = read('git', ['rev-parse', 'HEAD'], process.cwd());
  const result = spawnSync('node', ['scripts/assert-coordination.mjs'], {encoding: 'utf8',
    input: `refs/heads/main ${sha} refs/heads/main ${sha}\n`,
    env: {...process.env, TRELIO_AGENT_WORKSPACES_GUARDED_MAIN_PUSH: '1'}});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FIFO owner/);
});
