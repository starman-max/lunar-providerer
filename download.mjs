import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://raw.githubusercontent.com/starman-max/lunar-providerer/main/';
const OUT = fileURLToPath(new URL('./providers/', import.meta.url));

const indexRes = await fetch(BASE + 'index.json');
if (!indexRes.ok) throw new Error('index.json HTTP ' + indexRes.status);
const index = await indexRes.json();

await mkdir(OUT, { recursive: true });

const results = [];
for (const s of index.sources) {
  const url = BASE + s.file;
  try {
    const r = await fetch(url);
    if (!r.ok) { results.push({ id: s.id, ok: false, status: r.status }); continue; }
    const code = await r.text();
    await writeFile(join(OUT, s.id + '.js'), code, 'utf8');
    results.push({ id: s.id, ok: true, bytes: code.length });
  } catch (e) {
    results.push({ id: s.id, ok: false, error: String(e) });
  }
}

console.log(JSON.stringify(results, null, 2));
console.log('out dir:', OUT);