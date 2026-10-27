import { spawnSync } from 'node:child_process';

// Bind the existing Python public-boundary suite to Node-based review runners.
const result = spawnSync('uv', ['run', '--no-sync', 'python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_public_readability.py'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
