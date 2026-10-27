import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

// Reuse the Python boundary suite without duplicating its assertions.
test('Python public Markdown content, headers and privacy boundaries', () => {
  const result = spawnSync('uv', ['run', '--no-sync', 'python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_public_readability.py'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0);
});
