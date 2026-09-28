const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const outDir = 'dist-test';
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

function findTests(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.name.endsWith('.test.ts')) out.push(path.resolve(full));
  }
  return out;
}
const tests = findTests('test');

/** In test builds only, resolve the bare `vscode` specifier to the mock. */
const vscodeMockPlugin = {
  name: 'vscode-mock',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({
      path: path.resolve(__dirname, 'test', 'helpers', 'mockVscode.ts'),
    }));
  },
};

esbuild
  .build({
    entryPoints: tests,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outdir: outDir,
    sourcemap: false,
    plugins: [vscodeMockPlugin],
  })
  .then(() => {
    console.log('[lalog] test bundle complete');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });