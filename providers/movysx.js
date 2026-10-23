// MovySX — movie/series source for the Zangetsu provider repo (movy.sx).
//
// The site is a Next.js front-end over three keyless JSON APIs, so the whole
// chain is API/JSON (one HTML hop for rich detail metadata):
//   search/home  db.wecollege.net/3  (TMDB-compatible, no key)
//   detail       movy.sx/<movie|tv>/<tmdbId> __NEXT_DATA__ pageProps.details
//   episodes     seasons[].episode_count expanded client-side (TV)
//   streams      api.wecollege.net/{pool}/sources (seed + custom decode)
// Pools are tried in order and merged; the delhi pool additionally carries
// language-labelled sources (Hindi/English/...), so counterparts stay visible.
//
// Stream payloads are custom-encoded: GET /seed?mediaId= -> {seed, ttlMs},
// then GET /{pool}/sources?...&enc=2&seed= -> base64url blob. The blob is
// XORed with a keystream from a seed/mediaId-keyed PRNG (RC4-style S-box +
// FNV/murmur mixing, "mvm1"-prefixed). Pure JS below, no runtime crypto
// needed (same self-contained shape as gogoanime.js).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'movysx';

var SITE = 'https://www.movy.sx';
var DB = 'https://db.wecollege.net/3';
var STREAM = 'https://api.wecollege.net';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Pools in preference order: English pools first, then the language-labelled
// delhi pool (Hindi/English/... sources), then the remaining backups.
var POOLS = ['miami', 'seattle', 'atlanta', 'delhi'];

// Resolves when every promise has settled, or `graceMs` after the first one that produced a result,
// so one slow mirror/pool no longer holds up streams that are already available. Failures become null.
// Without setTimeout (some hosts) it simply waits for all of them, like Promise.all.
function _gather(promises, graceMs, hasResult) {
  return new Promise(function (resolve) {
    var out = new Array(promises.length), left = promises.length, timer = null, done = false;
    function finish() {
      if (done) return;
      done = true;
      if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
      resolve(out);
    }
    if (!left) return finish();
    promises.forEach(function (p, i) {
      Promise.resolve(p).then(function (v) { out[i] = v; }, function () { out[i] = null; }).then(function () {
        if (--left === 0) return finish();
        if (!timer && typeof setTimeout === 'function' && out[i] && hasResult(out[i])) timer = setTimeout(finish, graceMs);
      });
    });
  });
}

function getInfo() {
  return {
    name: 'Movy', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.svg', type: 'movie', version: '1.0.1'
  };
}

function _jheaders(ref) {
  return { 'User-Agent': UA, 'Referer': ref || SITE + '/', 'Accept': 'application/json' };
}
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || SITE + '/' }, timeoutMs: 12000 })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _tj(url, ref) {
  return fetch(url, { headers: _jheaders(ref), timeoutMs: 12000 }).then(function (r) {
    var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { j = null; } return j;
  }).catch(function () { return null; });
}
function _qs(params) {
  var parts = [];
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    var v = params[k];
    if (v === undefined || v === null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return parts.join('&');
}
function _img(path, size) {
  if (!path) return null;
  if (/^https?:/i.test(path)) return path;
  return 'https://image.tmdb.org/t/p/' + (size || 'w342') + (path.charAt(0) === '/' ? path : '/' + path);
}
function _trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

// ── Stream-payload codec (port of the site's own decoder) ────────────────────
// base64url + UTF-8, self-contained (same shape as gogoanime.js).
function _b64dec(s) {
  var t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4 !== 0) t += '=';
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  var out = [], i = 0;
  while (i < t.length) {
    var e1 = chars.indexOf(t.charAt(i++));
    var e2 = chars.indexOf(t.charAt(i++));
    var e3 = chars.indexOf(t.charAt(i++));
    var e4 = chars.indexOf(t.charAt(i++));
    if (e1 < 0 || e2 < 0) break;
    out.push((e1 << 2) | (e2 >> 4));
    if (e3 !== 64 && e3 >= 0) out.push(((e2 & 15) << 4) | (e3 >> 2));
    if (e4 !== 64 && e4 >= 0) out.push(((e3 & 3) << 6) | e4);
  }
  return out;
}
function _utf8dec(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    try { return new TextDecoder().decode(new Uint8Array(bytes)); } catch (e) {}
  }
  var out = '', i = 0;
  while (i < bytes.length) {
    var c = bytes[i++];
    if (c < 128) { out += String.fromCharCode(c); }
    else if (c > 191 && c < 224) { out += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63)); }
    else if (c > 223 && c < 240) {
      var c2 = bytes[i++], c3 = bytes[i++];
      out += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
    } else {
      var d2 = bytes[i++], d3 = bytes[i++], d4 = bytes[i++];
      var u = (((c & 7) << 18) | ((d2 & 63) << 12) | ((d3 & 63) << 6) | (d4 & 63)) - 0x10000;
      out += String.fromCharCode((u >> 10) + 0xD800, (u & 0x3FF) + 0xDC00);
    }
  }
  return out;
}
var _MV_L = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
var _MV_MAGIC = [109, 118, 109, 49]; // "mvm1"
function _rotl(e, a) { e >>>= 0; a &= 31; return a === 0 ? e >>> 0 : ((e << a) | (e >>> (32 - a))) >>> 0; }
function _fmix(e) {
  e >>>= 0; e ^= e >>> 16; e = Math.imul(e, 0x85ebca6b) >>> 0;
  e ^= e >>> 13; e = Math.imul(e, 0xc2b2ae35) >>> 0; return (e ^= e >>> 16) >>> 0;
}
function _fnv(str) {
  var a = 0x811c9dc5;
  for (var k = 0; k < str.length; k++) a = Math.imul(a ^ str.charCodeAt(k), 0x1000193) >>> 0;
  return _fmix(a);
}
function _mvBox(seed, mediaId) {
  var e = String(seed);
  if ((((e.length * (e.length + 1)) & 1) === 1)) {
    var a = [], t = 0, s;
    for (s = 0; s < 256; s++) a[s] = s;
    for (s = 0; s < 256; s++) { t = (t + a[s] + e.charCodeAt(s % e.length)) & 255; var n = a[s]; a[s] = a[t]; a[t] = n; }
    var acc = 0x67452301;
    for (var k = 0; k < e.length; k++) acc = _fmix(_rotl((acc ^ Math.imul(e.charCodeAt(k), _MV_L[k & 15])) >>> 0, 5));
    return { S: a, acc: acc };
  }
  var n = _fmix(((_fnv(e) ^ _fmix(((mediaId >>> 0) ^ 0x9e3779b9))) >>> 0)) >>> 0;
  var S = new Array(61);
  for (var j = 0; j < 8; j++) {
    if ((((j * (j + 1)) & 1) === 0)) {
      var at = n % 61;
      n = _rotl((n + 0x9e3779b9) >>> 0, 7 + (7 & j));
      S[at] = (n ^ _fmix(n)) >>> 0;
      n = _fmix((n + at) >>> 0);
    } else { S[j] = _MV_L[j & 15]; }
  }
  return { S: S, acc: _fmix((0xa5a5a5a5 ^ n) >>> 0) >>> 0 };
}
function _mvStream(box, len) {
  var out = [], d = 0;
  while (out.length < len) {
    var S = box.S, acc = box.acc;
    var l = acc % 61, inArr = Number(l in S), r = (S[l] || 0) >>> 0;
    var c = Math.imul(0x9e3779b9, d + 1) >>> 0;
    var tt = acc, ss = (r ^ c) >>> 0;
    var b = (((tt ^ ss) >>> 0) | ((tt & ss & (0 - inArr)) >>> 0)) >>> 0;
    b = (_rotl((b + acc) >>> 0, l & 31) ^ _rotl(acc, Math.imul(l, 7) & 31)) >>> 0;
    acc = _fmix((b + 0x9e3779b9) >>> 0);
    S[l] = acc >>> 0;
    box.acc = acc;
    var av = acc >>> 0; d++;
    out.push(av & 255);
    if (out.length < len) out.push((av >>> 8) & 255);
    if (out.length < len) out.push((av >>> 16) & 255);
    if (out.length < len) out.push((av >>> 24) & 255);
  }
  return out;
}
function _movyDecrypt(raw, seed, mediaId) {
  var ct = _b64dec(raw);
  if (!ct.length) throw new Error('Movy: empty payload');
  var ks = _mvStream(_mvBox(seed, mediaId), ct.length);
  var pt = [];
  for (var k = 0; k < ct.length; k++) pt.push(ct[k] ^ ks[k]);
  for (var g = 0; g < _MV_MAGIC.length; g++) {
    if (pt[g] !== _MV_MAGIC[g]) throw new Error('Movy: bad seed or tampered payload');
  }
  return _utf8dec(pt.slice(_MV_MAGIC.length));
}

// Seed cache mirrors the site (ttlMs, default 30s). Fetched once per
// getVideoSources and shared by all pools (seed is pool-independent).
var _seedCache = {};
var _seedFlight = {};
function _seed(mediaId, fresh) {
  var now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
  var hit = _seedCache[mediaId];
  if (hit && !fresh && hit.expiresAt > now) return Promise.resolve(hit.seed);
  if (!fresh && _seedFlight[mediaId]) return _seedFlight[mediaId];
  var pr = _tj(STREAM + '/seed?mediaId=' + encodeURIComponent(mediaId)).then(function (j) {
    if (!j || !j.seed) throw new Error('Movy: no seed');
    _seedCache[mediaId] = { seed: j.seed, expiresAt: now + (j.ttlMs || 30000) };
    return j.seed;
  });
  _seedFlight[mediaId] = pr;
  var clear = function () { delete _seedFlight[mediaId]; };
  pr.then(clear, clear);
  return pr;
}
function _poolSources(pool, q, mediaId, seed, retried) {
  var params = {};
  for (var k in q) {
    if (Object.prototype.hasOwnProperty.call(q, k) && q[k] !== undefined && q[k] !== null && q[k] !== '') params[k] = q[k];
  }
  params.enc = '2';
  params.seed = seed;
  return fetch(STREAM + '/' + pool + '/sources?' + _qs(params), { headers: _jheaders(), timeoutMs: 8000 })
    .then(function (r) { return r.body || ''; }).then(function (raw) {
      var dec;
      try { dec = _movyDecrypt(raw, seed, mediaId); }
      catch (e) {
        // Stale/invalid seed: refresh once and retry this pool only.
        if (!retried) return _seed(mediaId, true).then(function (ns) { return _poolSources(pool, q, mediaId, ns, true); });
        throw e;
      }
      var j; try { j = JSON.parse(dec); } catch (e) { throw new Error('Movy: bad sources payload'); }
      return j;
    });
}

// ── Catalog (TMDB-compatible DB, keyless) ────────────────────────────────────
function _card(m, kind) {
  if (!m || typeof m !== 'object') return null;
  if (m.media_type === 'person') return null;
  var id = m.id;
  if (id === undefined || id === null) return null;
  var isTv = kind === 'tv' || m.media_type === 'tv' || !!m.first_air_date;
  var title = m.title || m.name || m.original_title || m.original_name || ('#' + id);
  var cover = _img(m.poster_path, 'w342') || _img(m.backdrop_path, 'w342');
  if (!cover) return null;
  var kk = isTv ? 'tv' : 'movie';
  return {
    id: kk + '/' + id, title: _trim(String(title)), url: 'movy://' + kk + '/' + id,
    cover: cover, type: 'movie', sourceId: SOURCE_ID,
    year: ((m.release_date || m.first_air_date || '').slice(0, 4)) || null
  };
}
function _cards(list, kind) {
  var out = [], seen = {};
  list = list || [];
  for (var i = 0; i < list.length; i++) {
    var c = _card(list[i], kind);
    if (c && !seen[c.url]) { seen[c.url] = 1; out.push(c); }
  }
  return out;
}

function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1) return Promise.resolve([]);
  return _tj(DB + '/search/multi?' + _qs({ query: q, page: page || 1 })).then(function (j) {
    return _cards(j && j.results);
  }).catch(function () { return []; });
}

function getHome(opts) {
  var jobs = [
    _tj(DB + '/trending/movie/day?' + _qs({ region: 'US' })).then(function (j) {
      return { title: 'Trending Movies', items: _cards(j && j.results, 'movie') };
    }).catch(function () { return { title: 'Trending Movies', items: [] }; }),
    _tj(DB + '/trending/tv/day?' + _qs({ region: 'US' })).then(function (j) {
      return { title: 'Trending Shows', items: _cards(j && j.results, 'tv') };
    }).catch(function () { return { title: 'Trending Shows', items: [] }; }),
    _tj(DB + '/movie/popular?' + _qs({ region: 'US', page: 1 })).then(function (j) {
      return { title: 'Popular Movies', items: _cards(j && j.results, 'movie') };
    }).catch(function () { return { title: 'Popular Movies', items: [] }; }),
    _tj(DB + '/tv/popular?' + _qs({ region: 'US', page: 1 })).then(function (j) {
      return { title: 'Popular Shows', items: _cards(j && j.results, 'tv') };
    }).catch(function () { return { title: 'Popular Shows', items: [] }; })
  ];
  return Promise.all(jobs).then(function (rows) {
    return rows.filter(function (r) { return r.items.length; });
  }).catch(function () { return []; });
}

// ── Episode URL packing ──────────────────────────────────────────────────────
// movy://movie/<tmdbId>  |  movy://tv/<tmdbId>/<season>/<episode>
function _parseEp(episodeUrl) {
  var m = String(episodeUrl || '').match(/^movy:\/\/([^\/]+)\/(\d+)(?:\/(\d+)\/(\d+))?/);
  if (!m) return null;
  return { kind: m[1] === 'tv' ? 'tv' : 'movie', id: parseInt(m[2], 10), s: m[3] ? parseInt(m[3], 10) : 1, e: m[4] ? parseInt(m[4], 10) : 1 };
}

function _genresOf(det) {
  var g = [], cats = det.categories || det.genres || [];
  for (var i = 0; i < cats.length && g.length < 6; i++) {
    var c = cats[i];
    var name = (c && typeof c === 'object') ? (c.name || c.title || '') : String(c || '');
    name = _trim(name);
    if (name && g.indexOf(name) === -1) g.push(name);
  }
  return g;
}

function getDetail(url, opts) {
  var p = _parseEp(url);
  if (!p) {
    var m2 = String(url || '').match(/\/(movie|tv)\/(\d+)/);
    if (!m2) return Promise.resolve({ id: url, title: 'Unknown', url: url, episodes: [] });
    p = { kind: m2[1], id: parseInt(m2[2], 10), s: 1, e: 1 };
  }
  return _get(SITE + '/' + p.kind + '/' + p.id, SITE + '/').then(function (html) {
    var m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    var det = {};
    try { det = (((JSON.parse((m || [])[1] || '{}')).props || {}).pageProps || {}).details || {}; }
    catch (e) { det = {}; }
    var title = det.title || det.titleEnglish || ('#' + p.id);
    var base = {
      id: url, title: _trim(String(title)), url: url, cover: det.poster || null,
      description: _trim(String(det.desc || det.overview || '')), status: 'unknown',
      genres: _genresOf(det), studios: [], type: 'movie', sourceId: SOURCE_ID,
      episodes: [], year: det.year ? String(det.year) : null,
      tmdbId: det.tmdbId ? parseInt(det.tmdbId, 10) : p.id, tmdbIsTv: p.kind === 'tv',
      subCount: 0, dubCount: 0
    };
    if (p.kind !== 'tv') {
      base.episodes = [{ id: 'movie', number: 1, title: base.title, url: 'movy://movie/' + p.id }];
      base.subCount = 1;
      return base;
    }
    var seasons = det.seasons || [];
    var eps = [];
    for (var i = 0; i < seasons.length; i++) {
      var sn = seasons[i].season_number;
      if (sn === undefined || sn === null) sn = seasons[i].number;
      if (sn === undefined || sn === null) sn = seasons[i].season;
      sn = parseInt(sn, 10);
      if (isNaN(sn)) continue;
      var count = parseInt(seasons[i].episode_count || seasons[i].episodes || seasons[i].totalEpisodes || 0, 10) || 0;
      for (var e = 1; e <= count; e++) {
        eps.push({ id: 'S' + sn + 'E' + e, number: e,
          title: 'S' + sn + ' E' + e + ' - Episode ' + e, url: 'movy://tv/' + p.id + '/' + sn + '/' + e });
      }
    }
    base.episodes = eps;
    base.subCount = eps.length;
    return base;
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// Pool language labels double as audio hints (delhi pool).
function _audioLang(label, quality) {
  var t = (' ' + String(label || '') + ' ' + String(quality || '')).toLowerCase();
  if (/\bhindi\b/.test(t)) return 'hi';
  if (/\benglish\b|\beng\b/.test(t)) return 'en';
  return '';
}

function getVideoSources(episodeUrl) {
  var p = _parseEp(episodeUrl);
  if (!p) return Promise.reject(new Error('Movy: bad episode url'));
  _seed(p.id, false).catch(function () {}); // start the seed request now; it only needs the TMDB id
  var metaUrl = 'movy://' + p.kind + '/' + p.id + (p.kind === 'tv' ? '/' + p.s + '/' + p.e : '');
  return getDetail(metaUrl).then(function (det) {
    var q = {
      // Pre-encoded like the site itself (its client double-encodes the title).
      title: encodeURIComponent(det.title || ''),
      mediaType: p.kind === 'tv' ? 'tv' : 'movie',
      year: det.year || '',
      totalSeasons: 0,
      episodeId: p.kind === 'tv' ? p.e : 1,
      seasonId: p.kind === 'tv' ? p.s : 1,
      tmdbId: det.tmdbId || p.id
    };
    return _seed(q.tmdbId, false).then(function (seed) {
      var jobs = POOLS.map(function (pool) {
        return _poolSources(pool, q, q.tmdbId, seed, false).then(function (j) {
          return { pool: pool, j: j };
        }).catch(function () { return null; });
      });
      // first pool with streams wins; the others get 1.5 s to add theirs (a dead pool used to cost ~15 s)
      return _gather(jobs, 1500, function (r) { return r.j && r.j.sources && r.j.sources.length; }).then(function (results) {
        var out = [], seen = {}, subs = [], subSeen = {};
        for (var i = 0; i < results.length; i++) {
          var r = results[i];
          if (!r || !r.j) continue;
          var srcs = r.j.sources || [];
          for (var k = 0; k < srcs.length; k++) {
            var s = srcs[k];
            if (!s || !s.url || seen[s.url]) continue;
            seen[s.url] = 1;
            var qual = _trim(s.quality || s.label || 'auto');
            out.push({
              url: s.url, quality: qual || 'auto',
              container: /\.mp4(\?|$)/i.test(s.url) ? 'mp4' : 'hls',
              headers: { 'User-Agent': UA, 'Referer': SITE + '/' },
              kind: 'sub', audioLang: _audioLang(s.label, s.quality),
              subtitles: [], label: 'Movy [' + r.pool + ']'
            });
          }
          var tracks = r.j.subtitles || [];
          for (var t = 0; t < tracks.length; t++) {
            var tr = tracks[t];
            var tu = tr && (tr.url || tr.file);
            if (!tu || subSeen[tu]) continue;
            subSeen[tu] = 1;
            subs.push({ url: tu, lang: (tr && (tr.language || tr.label || tr.display)) || 'sub' });
          }
        }
        if (!out.length) throw new Error('Movy: no playable sources');
        for (var a = 0; a < out.length; a++) out[a].subtitles = subs;
        return out;
      });
    });
  });
}
