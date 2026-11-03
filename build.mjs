// Bündelt die Oberfläche (src/renderer/dist/app.js), die PDF-Seite (pdf.mjs) und die Dokument-Bibliotheken (src/dist/doclibs.js)
import { build } from 'esbuild';

const dev = process.argv.includes('--dev');
const common = { bundle: true, minify: !dev, sourcemap: dev ? 'inline' : false, legalComments: 'none', logLevel: 'warning' };

await build({ ...common, entryPoints: ['src/renderer/js/app.js'], format: 'iife', target: 'chrome130', outfile: 'src/renderer/dist/app.js' });
await build({ ...common, entryPoints: ['src/renderer/js/pdf.js'], format: 'esm', target: 'chrome130', outfile: 'src/renderer/dist/pdf.mjs' });
await build({ ...common, entryPoints: ['tools/doclibs-entry.js'], format: 'cjs', platform: 'node', target: 'node22', outfile: 'src/dist/doclibs.js' });
