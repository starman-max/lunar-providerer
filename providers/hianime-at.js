// HiAnime.at — Lunar's own anime provider (hianime.at backup source),
// ported from lib/data/extension_engine/scrapers/scraper_impls.dart
// (HiAnimeScraper) + megaplay_resolve.dart + zoko_resolve.dart +
// megaplay_crypto.dart.
// Search/theme episode+servers APIs; HD-1/Vidstream-2 via megaplay
// AES decrypt; ZokoAnime via XOR payload. Episode keys look like
// `hianime:<dataId>` (the theme API's numeric episode id).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'hianime-at';

var SITE = 'https://hianime.at';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function getInfo() {
  return {
    name: 'HiAnime.at',
    lang: 'en',
    baseUrl: SITE,
    type: 'anime',
    version: '1.0.0'
  };
}

function _headers(ref) {
  return {
    'User-Agent': UA,
    'Referer': ref || SITE + '/',
    'X-Requested-With': 'XMLHttpRequest'
  };
}

function _text(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}

function _get(url, ref) {
  return fetch(url, { headers: _headers(ref) })
    .then(function (r) { return r.body || ''; });
}

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

function _strBytes(s) {
  var t = String(s || ''), out = [];
  for (var i = 0; i < t.length; i++) {
    var c = t.charCodeAt(i);
    if (c < 128) { out.push(c); }
    else if (c < 2048) { out.push((c >> 6) | 192, (c & 63) | 128); }
    else if (c < 0xD800 || c > 0xDFFF) { out.push((c >> 12) | 224, ((c >> 6) & 63) | 128, (c & 63) | 128); }
    else {
      var hi = c, lo = t.charCodeAt(++i);
      var u = ((hi - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
      out.push((u >> 18) | 240, ((u >> 12) & 63) | 128, ((u >> 6) & 63) | 128, (u & 63) | 128);
    }
  }
  return out;
}

// ── AES-256-CBC decrypt (verified vs node:crypto) ────────────────────────
function _aesMul(a, b) {
  var p = 0;
  for (var i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    var hi = a & 0x80;
    a = (a << 1) & 0xFF;
    if (hi) a ^= 0x1B;
    b >>= 1;
  }
  return p;
}
var _AES_BOX = null;
function _aesBox() {
  if (_AES_BOX) return _AES_BOX;
  var s = new Array(256), inv = new Array(256);
  var gfInv = new Array(256);
  gfInv[0] = 0;
  for (var a = 1; a < 256; a++) {
    for (var b = 1; b < 256; b++) {
      if (_aesMul(a, b) === 1) { gfInv[a] = b; break; }
    }
  }
  for (var i = 0; i < 256; i++) {
    var x = gfInv[i];
    var v = x ^ ((x << 1) | (x >> 7)) ^ ((x << 2) | (x >> 6)) ^
            ((x << 3) | (x >> 5)) ^ ((x << 4) | (x >> 4));
    v = (v ^ 0x63) & 0xFF;
    s[i] = v;
    inv[v] = i;
  }
  _AES_BOX = { s: s, inv: inv };
  return _AES_BOX;
}
function _aesExpand(key) {
  var nk = key.length / 4, nr = nk + 6;
  var box = _aesBox();
  var w = [];
  for (var i = 0; i < nk; i++) {
    w.push((key[4*i] << 24) | (key[4*i+1] << 16) | (key[4*i+2] << 8) | key[4*i+3]);
  }
  var rcon = 1;
  for (i = nk; i < 4 * (nr + 1); i++) {
    var t = w[i-1];
    if (i % nk === 0) {
      t = ((box.s[(t >> 16) & 0xFF] << 24) | (box.s[(t >> 8) & 0xFF] << 16) |
           (box.s[t & 0xFF] << 8) | box.s[(t >>> 24) & 0xFF]) >>> 0;
      t ^= rcon << 24;
      rcon = _aesMul(rcon, 2);
    } else if (nk > 6 && i % nk === 4) {
      t = ((box.s[(t >>> 24)] << 24) | (box.s[(t >> 16) & 0xFF] << 16) |
           (box.s[(t >> 8) & 0xFF] << 8) | box.s[t & 0xFF]) >>> 0;
    }
    w.push((w[i-nk] ^ t) >>> 0);
  }
  return { w: w, nr: nr, box: box };
}
function _aesDecBlock(blk, ks) {
  var box = ks.box, w = ks.w, nr = ks.nr;
  var st = [[], [], [], []], c, r, round;
  for (c = 0; c < 4; c++)
    for (r = 0; r < 4; r++)
      st[c][r] = (blk[r+4*c] ^ (w[nr*4+c] >>> (24 - r*8))) & 0xFF;
  function isr() {
    var t;
    t = st[0][1]; st[0][1] = st[3][1]; st[3][1] = st[2][1]; st[2][1] = st[1][1]; st[1][1] = t;
    t = st[0][2]; st[0][2] = st[2][2]; st[2][2] = t;
    t = st[1][2]; st[1][2] = st[3][2]; st[3][2] = t;
    t = st[0][3]; st[0][3] = st[1][3]; st[1][3] = st[2][3]; st[2][3] = st[3][3]; st[3][3] = t;
  }
  function isb() {
    for (var cc = 0; cc < 4; cc++)
      for (var rr = 0; rr < 4; rr++) st[cc][rr] = box.inv[st[cc][rr]];
  }
  function ak(round) {
    for (var cc = 0; cc < 4; cc++)
      for (var rr = 0; rr < 4; rr++)
        st[cc][rr] = (st[cc][rr] ^ (w[round*4+cc] >>> (24 - rr*8))) & 0xFF;
  }
  function imc() {
    for (var cc = 0; cc < 4; cc++) {
      var a = st[cc][0], b = st[cc][1], d = st[cc][2], e = st[cc][3];
      st[cc][0] = _aesMul(a,14) ^ _aesMul(b,11) ^ _aesMul(d,13) ^ _aesMul(e,9);
      st[cc][1] = _aesMul(a,9) ^ _aesMul(b,14) ^ _aesMul(d,11) ^ _aesMul(e,13);
      st[cc][2] = _aesMul(a,13) ^ _aesMul(b,9) ^ _aesMul(d,14) ^ _aesMul(e,11);
      st[cc][3] = _aesMul(a,11) ^ _aesMul(b,13) ^ _aesMul(d,9) ^ _aesMul(e,14);
    }
  }
  isr(); isb();
  for (round = nr - 1; round >= 1; round--) { ak(round); imc(); isr(); isb(); }
  ak(0);
  var flat = [];
  for (c = 0; c < 4; c++)
    for (r = 0; r < 4; r++) flat.push(st[c][r]);
  return flat;
}
function _aesCbc(keyBytes, ivBytes, cipherBytes) {
  var ks = _aesExpand(keyBytes);
  var out = [], prev = ivBytes.slice(0);
  for (var off = 0; off < cipherBytes.length; off += 16) {
    var blk = cipherBytes.slice(off, off + 16);
    var dec = _aesDecBlock(blk, ks);
    for (var i = 0; i < 16; i++) out.push(dec[i] ^ prev[i]);
    prev = blk;
  }
  return out;
}
var _MP_KEY = 'i?LMTAx0Q6,:}50U';
var _MP_IV = "W0;27ToaUpl_P%'c";
function _mpDecrypt(enc) {
  var b64 = String(enc).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  var cipher = _b64dec(b64);
  var key = _strBytes(_MP_KEY);
  while (key.length < 32) key.push(0);
  var plain = _aesCbc(key, _strBytes(_MP_IV), cipher);
  var pad = plain[plain.length - 1];
  if (pad > 0 && pad <= 16 && plain.length >= pad) plain = plain.slice(0, plain.length - pad);
  return _utf8dec(plain);
}
function _mpFile(data) {
  try {
    if (data && typeof data.enc === 'string' && data.enc) {
      var obj = JSON.parse(_mpDecrypt(data.enc));
      if (obj && obj.file) return String(obj.file);
    }
  } catch (e) {}
  if (data && data.sources) {
    if (typeof data.sources.file === 'string') return data.sources.file;
    if (data.sources.length && data.sources[0] && data.sources[0].file) {
      return String(data.sources[0].file);
    }
  }
  return '';
}

// ZokoAnime: window.__P = base64(XOR(json, 'otaku-embed-v1')).
function _zokoFile(embedUrl) {
  return _get(embedUrl, SITE + '/').then(function (body) {
    var blob = (body.match(/window\.__P="([^"]+)"/) || [])[1] || '';
    if (!blob) throw new Error('ZokoAnime: no player payload');
    var raw = _b64dec(blob);
    var key = _strBytes('otaku-embed-v1');
    var dec = [];
    for (var i = 0; i < raw.length; i++) dec.push(raw[i] ^ key[i % key.length]);
    var data;
    try { data = JSON.parse(_utf8dec(dec)); }
    catch (e) { throw new Error('ZokoAnime: payload decode failed'); }
    var src = String((data && data.src) || '');
    if (src.indexOf('http') !== 0) throw new Error('ZokoAnime: no stream url');
    var subs = [];
    var arr = (data && data.subtitles) || [];
    for (var s = 0; s < arr.length; s++) {
      var u = String((arr[s] && (arr[s].src || arr[s].file)) || '');
      if (!u) continue;
      subs.push({ url: u, lang: String((arr[s] && (arr[s].lang || arr[s].label)) || 'sub') });
    }
    return { file: src, subtitles: subs };
  });
}

// Megaplay embed -> /stream/ data-id -> getSourcesNew -> decrypt.
function _megaFile(embedUrl, referer, isDub) {
  function h(ref, json) {
    var o = { 'User-Agent': UA, 'Referer': ref };
    if (json) { o.Accept = 'application/json'; o['X-Requested-With'] = 'XMLHttpRequest'; }
    return o;
  }
  return fetch(embedUrl, { headers: h(referer) })
    .then(function (r) { return r.body || ''; })
    .then(function (embedBody) {
      var streamUrl = embedUrl;
      if (!/data-id="(\d+)"/.test(embedBody)) {
        var f = embedBody.match(/<iframe[^>]+src="([^"]+\/stream\/[^"]+)"[^>]*>/i)
          || embedBody.match(/iframe[^>]+src="([^"]+\/stream\/[^"]+)"/i);
        streamUrl = f ? f[1] : '';
        if (!streamUrl) throw new Error('Embed has no stream frame');
        if (streamUrl.indexOf('//') === 0) streamUrl = 'https:' + streamUrl;
      }
      return fetch(streamUrl, { headers: h(embedUrl) })
        .then(function (r) { return r.body || ''; })
        .then(function (streamBody) {
          var dataId = (streamBody.match(/data-id="(\d+)"/) || [])[1];
          if (!dataId) throw new Error('Stream player id not found');
          var o = streamUrl.match(/^(https?:\/\/[^/]+)/);
          var host = o ? o[1] : streamUrl;
          return fetch(host + '/stream/getSourcesNew?id=' + dataId + '&type=' + (isDub ? 'dub' : 'sub'),
            { headers: h(streamUrl, true) }).then(function (r) { return r.json(); });
        });
    }).then(function (data) {
      if (!data || typeof data !== 'object') data = {};
      var file = _mpFile(data);
      if (!file) throw new Error('No stream file in embed response');
      var subs = [];
      var tracks = data.tracks || [];
      for (var i = 0; i < tracks.length; i++) {
        if (!tracks[i] || !tracks[i].file) continue;
        subs.push({ url: String(tracks[i].file), lang: String(tracks[i].label || tracks[i].kind || 'sub') });
      }
      return { file: file, subtitles: subs };
    });
}

// ── Search: .flw-item cards (sidebar markup cut first) ───────────────────
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (!q) return Promise.resolve([]);
  return _get(SITE + '/search?keyword=' + encodeURIComponent(q)).then(function (html) {
    var body = html.split('<div id="main-sidebar"')[0];
    var out = [], seen = {};
    var blocks = body.split(/<div[^>]+class="[^"]*flw-item[^"]*"/i);
    for (var b = 1; b < blocks.length; b++) {
      var blk = blocks[b];
      var a = blk.match(/<h3[^>]+class="[^"]*film-name[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
        || blk.match(/<a[^>]+href="([^"]+)"[^>]*(title="([^"]+)")?[^>]*>/i);
      if (!a) continue;
      var href = a[1];
      var slug = href.split('/').filter(function (s) { return !!s; }).pop();
      if (!slug || seen[slug]) continue;
      seen[slug] = 1;
      var title = '';
      var ta = blk.match(/<h3[^>]+class="[^"]*film-name[^"]*"[^>]*>[\s\S]*?<a[^>]*title="([^"]+)"/i);
      if (ta) { title = _text(ta[1]); }
      if (!title && a[3]) { title = _text(a[3]); }
      if (!title) {
        var inner = (blk.match(/<h3[^>]+class="[^"]*film-name[^"]*"[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || '';
        title = _text(inner);
      }
      if (!title) title = slug;
      var img = blk.match(/<img[^>]+(?:data-src|src)="([^"]+)"/i);
      out.push({
        id: slug,
        title: title,
        url: href.indexOf('http') === 0 ? href : SITE + (href.charAt(0) === '/' ? href : '/' + href),
        cover: img ? img[1] : null,
        type: 'anime',
        sourceId: SOURCE_ID
      });
    }
    return out;
  }).catch(function () { return []; });
}

function getDetail(url, opts) {
  return getEpisodes(url, opts).then(function (eps) {
    return {
      id: url,
      title: _text(String(url).split('/').filter(function (s) { return !!s; }).pop() || 'Unknown'),
      cover: null,
      url: url,
      description: '',
      status: 'unknown',
      genres: [],
      studios: [],
      type: 'anime',
      sourceId: SOURCE_ID,
      episodes: eps,
      subCount: eps.length,
      dubCount: 0
    };
  });
}

// slug -> numeric id -> /api/theme/episode/list/<id> (backslashes stripped)
// -> a.ep-item / a.ssl-item (data-id, data-number, title).
function getEpisodes(url, opts) {
  var slug = String(url).split('/').filter(function (s) { return !!s; }).pop().split('?')[0];
  var numeric = slug.split('-').pop();
  return _get(SITE + '/api/theme/episode/list/' + numeric).then(function (body) {
    var html = String(body || '').replace(/\\/g, '');
    var eps = [];
    var re = /<a[^>]+class="[^"]*(?:ep-item|ssl-item)[^"]*"[^>]*>/gi, m;
    while ((m = re.exec(html)) !== null) {
      var tag = m[0];
      var dataId = (tag.match(/data-id="([^"]*)"/i) || [])[1] || '';
      var numAttr = (tag.match(/data-number="([^"]*)"/i) || [])[1] || '';
      var n = parseInt(numAttr, 10) || 0;
      if (n <= 0) n = eps.length + 1;
      var title = (tag.match(/title="([^"]*)"/i) || [])[1] || ('Episode ' + n);
      eps.push({
        id: dataId || (slug + '?ep=' + n),
        number: n,
        title: _text(title),
        url: 'hianime:' + (dataId || (slug + '?ep=' + n))
      });
    }
    eps.sort(function (a, b) { return a.number - b.number; });
    return eps;
  }).catch(function () { return []; });
}

// servers -> HD-1/Vidstream first, Zoko next -> resolve -> flat list.
function getVideoSources(episodeUrl, opts) {
  var isDub = !!(opts && opts.dub);
  var dataId = String(episodeUrl || '');
  dataId = dataId.indexOf(':') >= 0 ? dataId.split(':').pop() : dataId;
  if (!dataId) return Promise.reject(new Error('HiAnime.at: empty episode id'));
  return _get(SITE + '/api/theme/episode/servers?episodeId=' + encodeURIComponent(dataId))
    .then(function (body) {
      var html = String(body || '').replace(/\\"/g, '"');
      var pool = [];
      var re = /<[a-z][^>]+class="[^"]*server-item[^"]*"[^>]*>/gi, m;
      while ((m = re.exec(html)) !== null) {
        var tag = m[0];
        var type = (tag.match(/data-type="([^"]*)"/i) || [])[1] || '';
        pool.push({
          type: type,
          name: (tag.match(/data-server-name="([^"]*)"/i) || [])[1] || '',
          hash: (tag.match(/data-hash="([^"]*)"/i) || [])[1] || ''
        });
      }
      var wanted = isDub ? 'dub' : 'sub';
      var sub = [];
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].type === wanted) sub.push(pool[i]);
      }
      if (!sub.length) {
        for (var j = 0; j < pool.length; j++) {
          if (pool[j].type === 'sub') sub.push(pool[j]);
        }
      }
      if (!sub.length) throw new Error('HiAnime.at: no servers for episode');
      function rank(e) {
        var n = String(e.name || '').toLowerCase();
        if (n.indexOf('hd-1') >= 0) return 0;
        if (n.indexOf('vidstream') >= 0) return 1;
        if (n.indexOf('zoko') >= 0) return 60;
        return 50;
      }
      sub.sort(function (a, b) { return rank(a) - rank(b); });
      var chain = Promise.reject(new Error('start'));
      sub.forEach(function (item) {
        chain = chain.catch(function (e) {
          if (String((e && e.message) || e) !== 'start') throw e;
          var embed = '';
          try {
            var raw = _b64dec(item.hash);
            embed = _utf8dec(raw).trim();
          } catch (ex) { throw new Error('HiAnime.at: bad server hash'); }
          if (embed.indexOf('http') !== 0) throw new Error('HiAnime.at: bad embed');
          if (/zoko/i.test(item.name)) {
            return _zokoFile(embed).then(function (z) {
              return [{
                url: z.file, quality: 'Auto', container: 'hls',
                headers: { 'User-Agent': UA, 'Referer': embed },
                subtitles: z.subtitles
              }];
            });
          }
          return _megaFile(embed, SITE + '/', isDub).then(function (z) {
            return [{
              url: z.file, quality: 'Auto', container: 'hls',
              headers: { 'User-Agent': UA, 'Referer': 'https://megaplay.buzz/' },
              subtitles: z.subtitles
            }];
          });
        });
      });
      return chain.catch(function (e) {
        if (String((e && e.message) || e) === 'start') throw new Error('HiAnime.at: no playable server');
        throw e;
      });
    });
}
