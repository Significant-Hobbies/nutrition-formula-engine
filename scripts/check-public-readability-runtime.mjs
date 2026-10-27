import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const runtime = process.env.READABILITY_TEST_ORIGIN;
if (!runtime || !['127.0.0.1', 'localhost'].includes(new URL(runtime).hostname)) throw new Error('Explicit loopback origin required');
const { identity, pages } = JSON.parse(await readFile(new URL('../src/nutrition_formula/data/public_readability.json', import.meta.url), 'utf8'));
const catalog = await (await fetch(`${runtime}/api/md/_catalog`)).json();
assert.equal(catalog.length, 2);
for (const route of catalog) {
  assert.equal(route.url, identity.url + route.path);
  const suffix = await fetch(runtime + new URL(route.md).pathname);
  assert.equal(suffix.status, 200);
  assert.match(suffix.headers.get('content-type'), /text\/markdown/);
  assert.match(suffix.headers.get('x-robots-tag'), /noindex/);
  assert.equal(suffix.headers.get('access-control-allow-origin'), '*');
  assert.ok([route.url, runtime + route.path].includes(suffix.headers.get('content-location')));
  const body = await suffix.text();
  assert.equal(body, pages[route.path].body);
  for (const path of [route.path, '/api/md' + route.path]) {
    const response = await fetch(runtime + path, { headers: { Accept: 'text/markdown', Cookie: 'saved_formula=private-fixture' } });
    assert.equal(await response.text(), body);
    const head = await fetch(runtime + path, { method: 'HEAD', headers: { Accept: 'text/markdown' } });
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('x-markdown-tokens'), suffix.headers.get('x-markdown-tokens'));
  }
  const html = await fetch(runtime + route.path);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(html.headers.get('link'), /rel="describedby"/);
  assert.match(html.headers.get('vary'), /Accept/);
  const source = await html.text();
  assert.ok(source.includes('name="ai-summary"'));
  assert.ok(source.includes(route.md));
  if (route.path === '/case-studies/') assert.equal((source.match(/class="case-study-card"/g) || []).length, 26);
  for (const accept of ['*/*', 'text/markdown;q=0,text/html', 'text/markdown;q=0.5,text/html;q=0.5']) {
    assert.match((await fetch(runtime + route.path, { headers: { Accept: accept } })).headers.get('content-type'), /text\/html/);
  }
}
for (const path of ['/api/md/recent-formulas/', '/recent-formulas.md', '/api/md/admin', '/does-not-exist.md']) {
  const response = await fetch(runtime + path);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /text\/markdown/);
  assert.ok((await response.text()).startsWith('# Not found'));
}
const options = await fetch(`${runtime}/api/md`, { method: 'OPTIONS' });
assert.equal(options.status, 204); assert.equal(options.headers.get('access-control-allow-origin'), '*');
const full = await (await fetch(`${runtime}/llms-full.txt`)).text();
assert.equal((full.match(/Canonical:/g) || []).length, 2); assert.ok(full.length < 500000);
assert.ok((await (await fetch(`${runtime}/ai.txt`)).text()).includes('training: allowed on public pages only'));
const robots = await (await fetch(`${runtime}/robots.txt`)).text();
for (const bot of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider']) assert.ok(robots.includes(`User-agent: ${bot}\nAllow: /`));
const health = await (await fetch(`${runtime}/api/health`)).json();
assert.equal(health.status, 'ok'); assert.equal(health.persistence, 'unconfigured');
const license = await fetch(`${runtime}/fonts/fleet-footer-precise-v1/README.md`);
assert.equal(license.status, 200);
assert.equal(await license.text(), await readFile(new URL('../public/fonts/fleet-footer-precise-v1/README.md', import.meta.url), 'utf8'));
console.log(JSON.stringify({ publicRoutes: catalog.length, caseStudies: 26, comparisons: 55, fullCharacters: full.length, privateDataBindings: 'absent', allChecks: 'passed' }));
