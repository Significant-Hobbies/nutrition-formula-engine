import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const footerAssets = [
  'footer-art/nutrition-formula-review-original-v1.webp',
  'fonts/fleet-footer-precise-v1/README.md',
  'fonts/fleet-footer-precise-v1/geist-OFL.txt',
  'fonts/fleet-footer-precise-v1/geist.woff2',
  'fonts/fleet-footer-precise-v1/geistmono-OFL.txt',
  'fonts/fleet-footer-precise-v1/geistmono.woff2',
  'fonts/fleet-footer-precise-v1/newsreader-OFL.txt',
  'fonts/fleet-footer-precise-v1/newsreader.woff2',
  'fonts/fleet-footer-precise-v1/provenance.json',
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

for (const path of footerAssets) {
  const source = await readFile(join('public', path));
  const output = await readFile(join('dist', path));
  if (sha256(source) !== sha256(output)) {
    throw new Error(`Deploy artifact differs from its public source: ${path}`);
  }
}

console.log(`Verified ${footerAssets.length} footer asset files in dist by SHA-256.`);
