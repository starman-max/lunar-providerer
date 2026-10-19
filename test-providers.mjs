// Zangetsu/Lunar provider host emulator + live scraper test harness.
// Providers are plain scripts expecting host globals: fetch, absUrl, htmlText,
// base64ToBytes, __SOURCE_ID. We re-create that host and drive the real
// end-to-end scrape path against live sites.
//
// NOTE: built-in intrinsics (Array/JSON/Object/...) are deliberately NOT injected
// into the sandbox — the vm realm supplies its own, so `x instanceof Array` and
// JSON.parse stay in one realm like the real host runtime.

import vm from 'node:vm';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PROVIDERS_DIR = fileURLToPath(new URL('./providers/', import.meta.url));

const QUERY = {
  fourkhdhub: 'batman', hdhub4u: 'batman', movysx: 'batman',
  flamecomics: 'solo leveling', mangakatana: 'naruto', weebcentral: 'naruto',
};
const DEFAULT_QUERY = 'naruto';
const UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function absUrl(href, base) {
  const h = String(href == null ? '' : href).trim();
  if (!h) return '';
  try { return new URL(h, base || undefined).href; } catch { return h; }
}
function htmlText(s) {
  return String(s == null ? '' : s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(String(b64 == null ? '' : b64).replace(/\s+/g, ''), 'base64'));
}

function makeFetch(netlog) {
  return async function hostFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : String(input && input.url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), init.timeoutMs || 30000);
  const rec = { url, method: init.method || 'GET', status: 0, error: null, bytes: 0, ms: 0 };
  netlog.push(rec);
  const started = Date.now();
    try {
      const follow = init.followRedirects !== false;
  const res = await fetch(url, {
        method: init.method || 'GET',
        headers: { 'User-Agent': UA_DEFAULT, ...(init.headers || {}) },
        body: init.body, redirect: follow ? 'follow' : 'manual', signal: ctrl.signal,
      });
      const body = await res.text();
      rec.status = res.status; rec.bytes = body.length;
      rec.ms = Date.now() - started;
      const h = {}; res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
      return { status: res.status, ok: res.ok, statusText: res.statusText, headers: h,
               body, json: async () => JSON.parse(body), text: async () => body };
    } catch (e) {
      rec.error = String((e && e.message) || e); rec.ms = Date.now() - started; throw e;
    } finally { clearTimeout(timer); }
  };
}

function buildContext(code, sourceId, netlog) {
  const sandbox = {
    __SOURCE_ID: sourceId,
    fetch: makeFetch(netlog),
    absUrl, htmlText, base64ToBytes,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    TextDecoder, TextEncoder, URL, URLSearchParams, Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: `${sourceId}.js`, timeout: 20000 });
  return context;
}

const withTimeout = (p, ms, label) =>
  Promise.race([Promise.resolve(p),
    new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(`harness timeout ${label} (${ms}ms)`)), ms); if (t.unref) t.unref(); })]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pushStep(steps, name, ok, detail, extra = {}) {
  steps.push({ name, ok, detail, ...extra });
  return ok;
}
// run fn, retrying transient network failures
async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return { value: await fn(), err: null }; }
    catch (e) { last = e; if (i < tries - 1) await sleep(2000 * (i + 1)); }
  }
  return { value: null, err: last };
}

function classifyMedia(buf) {
  const head = buf.subarray(0, 16);
  if (buf.subarray(0, 4).toString('hex') === '1a45dfa3') return { ok: true, kind: 'mkv/webm (EBML)' };
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return { ok: true, kind: 'mp4 (ISO-BMFF)' };
  const txt = buf.toString('latin1', 0, 16);
  if (txt.trimStart().startsWith('#EXTM3U')) return { ok: true, kind: 'hls m3u8' };
  if (/^\s*<(!doctype|html)/i.test(txt)) return { ok: false, kind: 'HTML link-resolver page (needs extra hop)' };
  return { ok: false, kind: `unknown head ${head.toString('hex')}` };
}

async function testProvider(id, code) {
  const netlog = [];
  const t0 = Date.now();
  const steps = [];
  const res = { id, steps, netlog, verdict: 'PASS', failed: [], ms: 0 };

  let ctx;
  try {
    ctx = buildContext(code, id, netlog);
    pushStep(steps, 'load', true, 'script evaluated (single-realm vm)');
  } catch (e) {
    pushStep(steps, 'load', false, String(e.message || e));
    res.verdict = 'FAIL'; res.failed = ['load']; res.ms = Date.now() - t0; return res;
  }

  let info = null;
  if (typeof ctx.getInfo === 'function') {
    try {
      info = await withTimeout(ctx.getInfo(), 5000, 'getInfo');
      const good = info && info.name && info.type;
      pushStep(steps, 'getInfo', !!good,
        good ? `${info.name} v${info.version || '?'} [${info.type}/${info.lang || '?'}] ${info.baseUrl || ''}`
             : 'missing name/type: ' + JSON.stringify(info));
    } catch (e) { pushStep(steps, 'getInfo', false, String(e.message || e)); }
  } else pushStep(steps, 'getInfo', false, 'function not exported');

  const type = (info && info.type) || 'anime';
  const isManga = type === 'manga';
  const query = QUERY[id] || DEFAULT_QUERY;
  const homeIsStub = /function getHome\s*\([^)]*\)\s*\{\s*return Promise\.resolve\(\[\]\)/.test(code);

  // getHome
  let homeItems = [];
  if (typeof ctx.getHome !== 'function') {
    pushStep(steps, 'getHome', null, 'not exported (optional)');
  } else if (homeIsStub) {
    pushStep(steps, 'getHome', null, 'intentional stub — returns [] in source (site is JS-rendered)');
  } else {
    const r = await retry(() => withTimeout(ctx.getHome({ category: 'sub' }), 45000, 'getHome'));
    if (r.err) pushStep(steps, 'getHome', false, String(r.err.message || r.err));
    else if (!Array.isArray(r.value)) pushStep(steps, 'getHome', false, 'not an array: ' + typeof r.value);
    else {
      homeItems = r.value.flatMap((x) => (x && Array.isArray(x.items)) ? x.items : []);
      pushStep(steps, 'getHome', homeItems.length > 0,
        homeItems.length ? `${r.value.length} rows / ${homeItems.length} items — ${r.value.map((x) => `${x.title}(${(x.items || []).length})`).join(', ')}`
                         : 'returned no items (0 rows)');
    }
  }

  // search
  let cards = [];
  {
    const r = await retry(() => withTimeout(ctx.search(query, 1, { category: 'sub' }), 45000, 'search'));
    if (r.err) pushStep(steps, 'search', false, String(r.err.message || r.err));
    else if (!Array.isArray(r.value)) pushStep(steps, 'search', false, 'not an array: ' + typeof r.value);
    else {
      cards = r.value.filter((c) => c && (c.url || c.id));
      pushStep(steps, 'search', cards.length > 0,
        cards.length ? `${r.value.length} results for "${query}" — first: "${cards[0].title}"`
                     : `0 results for "${query}"`, { count: r.value.length });
    }
  }

  const seed = cards[0] || homeItems.find((c) => c && (c.url || c.id)) || null;
  if (!pushStep(steps, 'seed', !!seed,
    seed ? `"${seed.title}" -> ${seed.url || seed.id}` : 'no seed from search or home')) {
    res.verdict = 'FAIL'; res.failed = ['seed']; res.ms = Date.now() - t0; return res;
  }
  const seedUrl = seed.url || seed.id;

  // getDetail
  let detail = null;
  {
    const r = await retry(() => withTimeout(ctx.getDetail(seedUrl, { category: 'sub' }), 60000, 'getDetail'));
    if (r.err) pushStep(steps, 'getDetail', false, String(r.err.message || r.err));
    else {
      detail = r.value;
      const good = detail && (detail.title || detail.id);
      pushStep(steps, 'getDetail', !!good,
        good ? `"${detail.title}" eps=${(detail.episodes || []).length} chs=${(detail.chapters || []).length} status=${detail.status || '-'} year=${detail.year || '-'}`
             : 'empty detail: ' + JSON.stringify(detail));
    }
  }
  if (!detail) { res.verdict = 'FAIL'; res.failed = ['getDetail']; res.ms = Date.now() - t0; return res; }

  if (isManga) {
    let chapters = Array.isArray(detail.chapters) ? detail.chapters : [];
    if (typeof ctx.getChapters === 'function') {
      const r = await retry(() => withTimeout(ctx.getChapters(seedUrl, { category: 'sub' }), 60000, 'getChapters'));
      if (r.err) pushStep(steps, 'getChapters', false, String(r.err.message || r.err));
      else if (!Array.isArray(r.value)) pushStep(steps, 'getChapters', false, 'not an array');
      else {
        chapters = r.value;
        pushStep(steps, 'getChapters', r.value.length > 0,
          r.value.length ? `${r.value.length} chapters — first: "${(r.value[0].title || '').slice(0, 40)}" (${(r.value[0].url || r.value[0].id || '').slice(0, 60)})`
                          : '0 chapters');
      }
    } else pushStep(steps, 'getChapters', chapters.length > 0,
      chapters.length ? `${chapters.length} (from detail)` : 'none');

    const chap = chapters[0];
    if (!chap) pushStep(steps, 'getPages', false, 'no chapter to open');
    else if (typeof ctx.getPages !== 'function') pushStep(steps, 'getPages', false, 'function not exported');
    else {
      const r = await retry(() => withTimeout(ctx.getPages(seedUrl, chap.url || chap.id, { category: 'sub' }), 60000, 'getPages'));
      if (r.err) pushStep(steps, 'getPages', false, String(r.err.message || r.err));
      else {
        const p = r.value;
        const good = Array.isArray(p) && p.length > 0 && p.every((x) => x && x.url);
        pushStep(steps, 'getPages', !!good,
          good ? `${p.length} pages — ${String(p[0].url).slice(0, 78)}`
               : Array.isArray(p) ? '0 pages' : 'not an array: ' + typeof p);
        if (good) {
          const ir = await retry(async () => {
            const r2 = await fetch(p[0].url, { headers: p[0].headers || {}, redirect: 'follow', signal: AbortSignal.timeout(20000) });
            return { status: r2.status, ct: r2.headers.get('content-type') };
          }, 2);
          if (ir.err) pushStep(steps, 'pageImageFetch', false, String(ir.err.message || ir.err));
          else pushStep(steps, 'pageImageFetch', ir.value.status < 400,
            `HTTP ${ir.value.status} ${ir.value.ct || ''}`);
        }
      }
    }
  } else {
    let episodes = Array.isArray(detail.episodes) ? detail.episodes : [];
    if (typeof ctx.getEpisodes === 'function') {
      const r = await retry(() => withTimeout(ctx.getEpisodes(seedUrl, { category: 'sub' }), 60000, 'getEpisodes'));
      if (r.err) pushStep(steps, 'getEpisodes', false, String(r.err.message || r.err));
      else if (!Array.isArray(r.value)) pushStep(steps, 'getEpisodes', false, 'not an array');
      else {
        episodes = r.value;
        pushStep(steps, 'getEpisodes', r.value.length > 0,
          r.value.length ? `${r.value.length} episodes — first: ep${r.value[0].number} "${(r.value[0].title || '').slice(0, 40)}"`
                          : '0 episodes');
      }
    } else pushStep(steps, 'getEpisodes', episodes.length > 0,
      episodes.length ? `${episodes.length} (from detail)` : 'none');

    const ep = episodes[0];
    if (!ep) pushStep(steps, 'getVideoSources', false, 'no episode to play');
    else if (typeof ctx.getVideoSources !== 'function') pushStep(steps, 'getVideoSources', false, 'function not exported');
    else {
      const t = Date.now();
      const r = await retry(() => withTimeout(ctx.getVideoSources(ep.url || ep.id), 120000, 'getVideoSources'));
      const secs = ((Date.now() - t) / 1000).toFixed(1);
      if (r.err) pushStep(steps, 'getVideoSources', false, String(r.err.message || r.err), { secs });
      else {
        const v = r.value;
        const deviant = !(Array.isArray(v)) && Array.isArray(v && v.sources);
        const list = Array.isArray(v) ? v : (deviant ? v.sources : null);
        const good = Array.isArray(list) && list.length > 0 && list.every((x) => x && x.url);
        pushStep(steps, 'getVideoSources', !!good,
          good ? `${deviant ? 'DEVIANT {sources} object' : 'array'}(${list.length}) in ${secs}s: ${list.map((x) => `${x.quality}/${x.container}`).join(', ')} — ${String(list[0].url).slice(0, 72)}${(list[0].subtitles || []).length ? ` (+${list[0].subtitles.length} subs)` : ''}`
               : Array.isArray(list) ? `0 sources (${secs}s)` : 'not an array: ' + typeof v, { secs, deviant });
         if (good) {
           const pick = list.find((x) => x.container === 'hls') || list[0];
           const hdrs = pick.headers || (v && v.headers) || {};
           const sfStart = Date.now();
           try {
             const rr = await fetch(pick.url, { headers: { ...hdrs, Range: 'bytes=0-4095' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
             const reader = rr.body && rr.body.getReader ? rr.body.getReader() : null;
             let buf = Buffer.alloc(0);
             if (reader) {
               const { value } = await reader.read();
               if (value) buf = Buffer.from(value);
               try { reader.cancel(); } catch (e) {}
             } else {
               const ab = await rr.arrayBuffer();
               buf = Buffer.from(ab.slice(0, 4096));
             }
             const cls = classifyMedia(buf);
             const sfMs = Date.now() - sfStart;
             pushStep(steps, 'streamFetch', rr.ok && cls.ok,
               `HTTP ${rr.status} ${rr.headers.get('content-type') || ''} — ${cls.kind} (${sfMs}ms)`, { deviantOnly: deviant, ms: sfMs });
           } catch (e) {
             const sfMs = Date.now() - sfStart;
             pushStep(steps, 'streamFetch', false, `${String(e.message || e)} (${sfMs}ms)`, { deviantOnly: deviant, ms: sfMs });
           }
         }
      }
    }
  }

  const failed = steps.filter((s) => s.ok === false).map((s) => s.name);
  res.failed = failed;
  res.verdict = failed.length ? 'FAIL' : 'PASS';
  res.ms = Date.now() - t0;
  return res;
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = (await readdir(PROVIDERS_DIR)).filter((f) => f.endsWith('.js')).sort();
const results = [];
for (const f of files) {
  const id = f.replace(/\.js$/, '');
  if (only.length && !only.includes(id)) continue;
  const code = await readFile(PROVIDERS_DIR + f, 'utf8');
  process.stdout.write(`testing ${id} ... `);
  const r = await testProvider(id, code);
  results.push(r);
  console.log(`${r.verdict} (${(r.ms / 1000).toFixed(1)}s)`);
}

console.log('\n' + '='.repeat(104));
console.log('ZANGSETSU / LUNAR PROVIDER SCRAPER TEST — LIVE END-TO-END RESULTS');
console.log('='.repeat(104));
for (const r of results) {
  console.log(`\n[${r.verdict}] ${r.id}  (${(r.ms / 1000).toFixed(1)}s, ${r.netlog.length} http requests)`);
  for (const s of r.steps) {
    const mark = s.ok === null ? ' -- ' : s.ok ? ' ok ' : 'FAIL';
    const warn = s.deviant ? '  <== SHAPE DEVIATION' : '';
    console.log(`   ${mark}  ${s.name.padEnd(16)} ${s.detail}${warn}`);
  }
  const bad = r.netlog.filter((n) => n.error || (n.status && n.status >= 400));
  if (bad.length) {
    console.log('   network problems:');
    for (const e of bad.slice(0, 8)) console.log(`     ${String(e.status || 'ERR').padEnd(4)} ${e.method} ${e.url.slice(0, 96)}${e.error ? ' :: ' + e.error : ''}`);
  }
  const slow = [...r.netlog].sort((a,b) => (b.ms||0)-(a.ms||0)).slice(0, 5);
  console.log('   slowest requests:');
  for (const e of slow) console.log(`     ${String(e.ms).padStart(6)}ms ${String(e.status||'ERR').padEnd(4)} ${e.method} ${e.url.slice(0, 88)} (${e.bytes}b)`);
}
const pass = results.filter((r) => r.verdict === 'PASS');
const fail = results.filter((r) => r.verdict === 'FAIL');
console.log('\n' + '='.repeat(104));
console.log(`SUMMARY: ${pass.length}/${results.length} PASS`);
console.log('  PASS: ' + pass.map((r) => r.id).join(', '));
console.log('  FAIL: ' + (fail.map((r) => `${r.id}[${r.failed.join('/')}]`).join(', ') || 'none'));
console.log('='.repeat(104));