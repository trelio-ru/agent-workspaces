#!/usr/bin/env node
/** Native Antigravity shell installation.
 * Google documents absolute stdio commands, but no plugin-root substitution.
 * Materialize paths only on the target computer; never ship home paths in source
 * or copy Codex/Claude hook definitions into Antigravity's auto-discovery root.
 * Domain execution still belongs to the original signed loader/runtime.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PLUGIN_VERSION } from '../plugins/trelio-agent-workspaces/scripts/trelio-host-runtime-shell.mjs';

const sourceRoot = fileURLToPath(new URL('../plugins/trelio-agent-workspaces/', import.meta.url));
const markerName = '.trelio-antigravity-install.json';
const skills = ['trelio-workspace-worker', 'trelio-skill-catalog', 'trelio-project-access', 'trelio-private-skill-management'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Reject symlinks instead of dereferencing unrelated content into an install.
// The same inventory protects human edits and extra files on future upgrades.
const inventory = async (directory, prefix = '') => {
  const files = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Установка содержит symlink; автоматическая замена запрещена.');
    if (entry.isDirectory()) files.push(...await inventory(absolute, relative));
    else if (entry.isFile()) files.push({ path: relative, sha256: digest(await fs.readFile(absolute)) });
    else throw new Error('Установка содержит неподдерживаемый тип файла.');
  }
  return files;
};
const copyTree = async (source, destination) => {
  const metadata = await fs.lstat(source);
  if (metadata.isSymbolicLink()) throw new Error('Исходный shell содержит symlink.');
  if (metadata.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of (await fs.readdir(source)).sort()) await copyTree(path.join(source, name), path.join(destination, name));
  } else if (metadata.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  } else throw new Error('Неподдерживаемый файл shell.');
};

export const buildAntigravityMcpConfig = (directory, nodePath) => ({ mcpServers: {
  trelio: { serverUrl: 'https://trelio.ru/mcp', oauth: { clientId: 'trelio_antigravity_agent_workspaces_v1' } },
  'trelio-remote-skills': { command: nodePath, args: [path.join(directory, 'scripts/trelio-host-runtime-loader.mjs'), 'mcp'], cwd: directory },
} });

const installLocked = async (canonicalTarget, nodePath) => {
  const parent = path.dirname(canonicalTarget);
  const canonicalNode = await fs.realpath(nodePath);
  let previous = null;
  try {
    const metadata = await fs.lstat(canonicalTarget);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Небезопасный каталог установки.');
    const files = await inventory(canonicalTarget);
    const marker = JSON.parse(await fs.readFile(path.join(canonicalTarget, markerName), 'utf8'));
    if (marker.format !== 'trelio-antigravity-shell/v1' || !Array.isArray(marker.files)
      || JSON.stringify(files.filter((file) => file.path !== markerName)) !== JSON.stringify(marker.files)) {
      throw new Error('Установка изменена; сохраните изменения перед обновлением.');
    }
    previous = files;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // An existing unmarked directory is never an empty/first installation.
    try { await fs.lstat(canonicalTarget); throw new Error('Существующая установка не управляется Trelio.'); }
    catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
  }
  const stage = path.join(parent, `.trelio-antigravity-stage-${randomUUID()}`);
  const backup = path.join(parent, `.trelio-antigravity-backup-${randomUUID()}`);
  let moved = false;
  await fs.mkdir(stage);
  try {
    await copyTree(path.join(sourceRoot, '.antigravity-plugin/plugin.json'), path.join(stage, 'plugin.json'));
    await copyTree(path.join(sourceRoot, 'scripts'), path.join(stage, 'scripts'));
    for (const skill of skills) await copyTree(path.join(sourceRoot, 'skills', skill), path.join(stage, 'skills', skill));
    await fs.writeFile(path.join(stage, 'PLUGIN_VERSION'), `${PLUGIN_VERSION}\n`);
    await fs.writeFile(path.join(stage, 'mcp_config.json'), `${JSON.stringify(buildAntigravityMcpConfig(canonicalTarget, canonicalNode), null, 2)}\n`);
    const files = await inventory(stage);
    await fs.writeFile(path.join(stage, markerName), `${JSON.stringify({ format: 'trelio-antigravity-shell/v1', pluginVersion: PLUGIN_VERSION, files }, null, 2)}\n`);
    // Recheck immediately before replacement: an edit during staging must not
    // disappear. Rename preserves the previous install for rollback on failure.
    if (previous) {
      if (JSON.stringify(await inventory(canonicalTarget)) !== JSON.stringify(previous)) throw new Error('Установка изменилась во время подготовки.');
      await fs.rename(canonicalTarget, backup); moved = true;
      // Check the renamed snapshot too: a human edit between inventory and
      // rename must roll back, rather than get deleted with the old install.
      if (JSON.stringify(await inventory(backup)) !== JSON.stringify(previous)) throw new Error('Установка изменилась во время замены.');
    } else {
      try { await fs.lstat(canonicalTarget); throw new Error('Каталог установки появился во время подготовки.'); }
      catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
    }
    await fs.rename(stage, canonicalTarget);
  } catch (error) {
    if (moved) await fs.rename(backup, canonicalTarget);
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
  if (moved) await fs.rm(backup, { recursive: true });
  return { directory: canonicalTarget, pluginVersion: PLUGIN_VERSION, restartRequired: true };
};

export const installAntigravity = async ({
  destination = path.join(os.homedir(), '.gemini/config/plugins/trelio-agent-workspaces'),
  nodePath = process.execPath,
} = {}) => {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Для установки требуется Node.js 22+.');
  const target = path.resolve(destination);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Lock the canonical parent/name before inspecting or staging. Two installers
  // must not replace each other's first install or roll back another upgrade.
  // A leftover lock is a visible interruption; do not guess its age or delete
  // a potentially live owner's lock automatically.
  const canonicalTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
  const lock = path.join(path.dirname(canonicalTarget), `.${path.basename(target)}.trelio-install-lock`);
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Установка уже выполняется или остался lock прерванного установщика.'); throw error; }
  try { return await installLocked(canonicalTarget, nodePath); }
  finally { await fs.rmdir(lock); }
};

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--destination')) throw new Error('Используйте --destination <каталог> либо запуск без аргументов.');
  const result = await installAntigravity(args.length ? { destination: args[1] } : {});
  process.stdout.write(`Trelio ${result.pluginVersion} установлен: ${result.directory}\nПерезагрузите Antigravity и завершите native OAuth в Customizations.\n`);
}
