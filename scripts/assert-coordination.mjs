import fs from 'node:fs';
import {assertPush, read} from '@trelio/git-coordinator/coordinator';
try {
  let sha = process.argv[2], tag = process.argv[3] ?? '';
  if (!sha) {
    let tagSha;
    for (const line of fs.readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
      const fields = line.split(' ');
      if (fields.length !== 4) throw Error('Incomplete push inventory');
      const [, oid, remote] = fields;
      if (remote === 'refs/heads/main') sha = oid;
      else if (/^refs\/tags\/(?:v|codex-hooks-source-v|skill-[a-z0-9-]+-v)\d+\.\d+\.\d+$/u.test(remote)) {
        if (tag) throw Error('Push exactly one queued release tag');
        tag = remote.slice(10);
        tagSha = read('git', ['rev-parse', '--verify', `${oid}^{commit}`], process.cwd());
      }
    }
    if (sha && tagSha && sha !== tagSha) throw Error('Main/tag source mismatch');
    sha ??= tagSha;
    if (!sha) process.exit(0);
  }
  assertPush(process.cwd(), sha, tag);
} catch (error) { console.error(error.message); process.exitCode = 1; }
