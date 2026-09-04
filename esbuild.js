const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  sourcemap: true,
  minify: false,
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[lalog] watching for changes...');
  } else {
    await esbuild.build(options);
    console.log('[lalog] build complete');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
