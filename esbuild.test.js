const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const outDir = 'dist-test';
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const tests = fs
  .readdirSync('test')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.resolve('test', f));

esbuild.buildSync({
  entryPoints: tests,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outdir: outDir,
  sourcemap: false,
});
console.log('[lalog] test bundle complete');
