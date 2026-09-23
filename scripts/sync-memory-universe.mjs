import {copyFile, mkdir, access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, '../memory-scene-2');
const target = path.join(root, 'public/memory-universe');
const files = ['index.html', 'app.js', 'styles.css', 'memory-client.js'];
try { await access(path.join(source, 'memory-client.js')); }
catch {
  // A standalone checkout ships the last synced assets; no sibling repo is required.
  await Promise.all(files.map(file => access(path.join(target, file))));
  console.log('Using bundled memory universe assets.');
  process.exit(0);
}
await mkdir(target, {recursive: true});
for (const file of files) await copyFile(path.join(source, file), path.join(target, file));
console.log('Synced memory-scene-universe-v2-globe integration.');
