import {verifyHosted} from '@trelio/git-coordinator/hosted-ci';
const [mode, sha] = process.argv.slice(2);
if (mode !== '--prepare' || !/^[a-f0-9]{40}$/u.test(sha ?? '')) throw Error('Use --prepare SHA');
await verifyHosted(process.cwd(), sha, [{"file": "plugin-tests.yml", "jobs": ["Codex same-thread tool exposure", "Canonical main Git guard", "Codex Windows update without restart or changed hook trust", "Stable plugin shell (ubuntu-latest)", "Stable plugin shell (macos-latest)", "Stable plugin shell (windows-latest)"]}], {prepare: true});
