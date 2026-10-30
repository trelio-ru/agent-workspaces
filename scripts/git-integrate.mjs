// Maintainer-only dependency pinned by package-lock.json; never part of a plugin/provider payload.
import {main} from '@trelio/git-coordinator/coordinator';
main().catch(error => { console.error(error.message); process.exitCode = 1; });
