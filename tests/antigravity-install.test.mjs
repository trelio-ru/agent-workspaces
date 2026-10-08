import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { installAntigravity } from '../scripts/install-antigravity.mjs';

test('native Antigravity install materializes both servers without discovering foreign hooks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-antigravity-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'plugin with spaces');
  const result = await installAntigravity({ destination });
  const config = JSON.parse(await fs.readFile(path.join(result.directory, 'mcp_config.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.trelio, { serverUrl: 'https://trelio.ru/mcp', oauth: { clientId: 'trelio_antigravity_agent_workspaces_v1' } });
  const local = config.mcpServers['trelio-remote-skills'];
  assert.equal(local.command, await fs.realpath(process.execPath));
  assert.deepEqual(local.args, [path.join(result.directory, 'scripts/trelio-host-runtime-loader.mjs'), 'mcp']);
  assert.equal(local.cwd, result.directory);
  for (const excluded of ['hooks', 'hooks.json', '.codex-plugin', '.claude-plugin', '.cursor-plugin', 'skills/trelio-project-onboarding']) {
    await assert.rejects(fs.stat(path.join(result.directory, excluded)), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(path.join(result.directory, 'scripts/trelio-host-runtime-loader.mjs'), 'utf8'),
    await fs.readFile(new URL('../plugins/trelio-agent-workspaces/scripts/trelio-host-runtime-loader.mjs', import.meta.url), 'utf8'));
  await installAntigravity({ destination });
  await fs.appendFile(path.join(destination, 'mcp_config.json'), 'human edit');
  await assert.rejects(installAntigravity({ destination }), /изменена/);
  assert.match(await fs.readFile(path.join(destination, 'mcp_config.json'), 'utf8'), /human edit$/);
});

test('unmanaged directories and symlink destinations are preserved', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-antigravity-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'existing');
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'personal.txt'), 'keep');
  await assert.rejects(installAntigravity({ destination }), /не управляется/);
  assert.equal(await fs.readFile(path.join(destination, 'personal.txt'), 'utf8'), 'keep');
  // Directory symlinks on Windows require Developer Mode/admin; do not change
  // OS policy to create the fixture. Native junctions exercise the same guard.
  await fs.symlink(destination, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installAntigravity({ destination: path.join(root, 'link') }), /Небезопасный/);
});

test('concurrent installers cannot replace or roll back another install', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-antigravity-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'plugin');
  const results = await Promise.allSettled([installAntigravity({ destination }), installAntigravity({ destination })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /lock/);
  // The winning install stays complete and can be upgraded after lock cleanup.
  await installAntigravity({ destination });
  assert.deepEqual(await fs.readdir(root), ['plugin']);
});
