// GogoAnime — Lunar's own anime provider, ported from
// lib/data/extension_engine/scrapers/scraper_impls.dart (GogoScraper) +
// megaplay_resolve.dart + megaplay_crypto.dart.
// Episode page -> newplayer embed -> /stream/ data-id ->
// {host}/stream/getSourcesNew -> AES-256-CBC decrypt `enc` -> HLS + VTT.
// (AES implementation verified against node:crypto vectors.)

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'gogoanime';

var MIRRORS = ['https://www.gogoanime.is', 'https://gogoanimes.fi'];
var SITE = MIRRORS[0];
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function getInfo() {
  return {
    name: 'GogoAnime',
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

// Mirror loop: first 200 wins (mirrors the Dart _get).
function _get(path) {
  var chain = Promise.reject(new Error('start'));
  MIRRORS.forEach(function (m) {
    chain = chain.catch(function (e) {
      if (String((e && e.message) || e) !== 'start') throw e;
      return fetch(m + path, { headers: _headers(m) })
        .then(function (r) { return r.body || ''; });
    });
  });
  return chain.catch(function () {
    return Promise.reject(new Error('GogoAnime: all mirrors failed for ' + path));
  });
}

function _abs(href, base) {
  var h = String(href || '');
  var b = base || SITE;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.indexOf('//') === 0) return 'https:' + h;
  if (h.charAt(0) === '/') {
    var o = b.match(/^(https?:\/\/[^/]+)/);
    return (o ? o[1] : b) + h;
  }
  return b + '/' + h;
}

// ── base64 (std + url-safe) + UTF-8 decode (self-contained) ──────────────
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

// MegaPlay `enc` decrypt: AES-256-CBC, key = ASCII key zero-padded to 32B.
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

// ── Search / detail / episodes (HTML, regex-parsed) ──────────────────────
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (!q) return Promise.resolve([]);
  return _get('/search.html?keyword=' + encodeURIComponent(q)).then(function (html) {
    var out = [], seen = {};
    var blocks = html.split(/<li[^>]*>/i);
    for (var b = 1; b < blocks.length; b++) {
      var blk = blocks[b];
      var a = blk.match(/<a[^>]+href="([^"]*\/category\/[^"]*)"[^>]*>/i);
      if (!a) continue;
      var href = a[1];
      if (seen[href]) continue;
      seen[href] = 1;
      var ta = (a[0].match(/title="([^"]+)"/i) || [])[1] || '';
      var nm = blk.match(/class="[^"]*\bname\b[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
      var title = _text(ta || (nm ? nm[1] : '') || href.split('/').pop());
      var img = blk.match(/<img[^>]+src="([^"]+)"/i);
      out.push({
        id: href.split('/').pop(),
        title: title || 'Unknown',
        url: href,
        cover: img ? _abs(img[1], SITE) : null,
        type: 'anime',
        sourceId: SOURCE_ID
      });
    }
    if (!out.length) {
      // Fallback: generic category-link scan.
      var re = /<a[^>]+href="([^"]*\/category\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, m;
      while ((m = re.exec(html)) !== null) {
        if (seen[m[1]]) continue;
        seen[m[1]] = 1;
        var ta2 = (m[0].match(/title="([^"]+)"/i) || [])[1] || '';
        out.push({
          id: m[1].split('/').pop(),
          title: _text(ta2 || m[2] || m[1].split('/').pop()),
          url: m[1],
          cover: null,
          type: 'anime',
          sourceId: SOURCE_ID
        });
      }
    }
    return out;
  }).catch(function () { return []; });
}

function getDetail(url, opts) {
  return getEpisodes(url, opts).then(function (eps) {
    var slug = String(url).split('/').filter(function (s) { return !!s; }).pop() || 'Unknown';
    return {
      id: url,
      title: _text(slug.replace(/-/g, ' ')),
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

function getEpisodes(url, opts) {
  var id = String(url).split('/').filter(function (s) { return !!s; }).pop();
  return _get('/category/' + id).then(function (html) {
    var eps = _epsFromAnchors(html);
    if (eps.length) return eps;
    // Legacy ajax layout fallback (older Gogo themes).
    var epEnd = (html.match(/id="episode_page"[\s\S]{0,500}?ep_end="(\d+)"/i) || [])[1];
    var alias = (html.match(/class="[^"]*anime_info_body_bg[^"]*"[\s\S]{0,2000}?class="[^"]*\btype\b[^"]*"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/i) || [])[1]
      || id;
    if (!epEnd) return eps;
    return _get('/ajax/load-list-episode?ep_start=1&ep_end=' + epEnd + '&id=' + encodeURIComponent(_text(alias)))
      .then(function (lhtml) { return _epsFromAnchors(lhtml); })
      .catch(function () { return eps; });
  }).catch(function () { return []; });
}

function _epsFromAnchors(html) {
  var byNum = {};
  var re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, m;
  while ((m = re.exec(html)) !== null) {
    var href = m[1];
    var em = href.match(/-episode-(\d+)/);
    if (!em) continue;
    var num = parseInt(em[1], 10);
    if (!num || byNum[num]) continue;
    var txt = _text(m[2]);
    byNum[num] = {
      id: href.split('/').pop(),
      number: num,
      title: txt || ('Episode ' + num),
      url: href
    };
  }
  var eps = [];
  for (var k in byNum) eps.push(byNum[k]);
  eps.sort(function (a, b) { return a.number - b.number; });
  return eps;
}

// Episode page -> newplayer embed (hd-1 preferred) -> megaplay resolve.
function getVideoSources(episodeUrl, opts) {
  var u = String(episodeUrl || '');
  var path, ep;
  if (u.indexOf('http') === 0) {
    var mo = u.match(/^https?:\/\/[^/]+(\/.*)$/);
    path = mo ? mo[1] : '/';
    ep = u;
  } else {
    path = u.charAt(0) === '/' ? u : '/' + u;
    ep = SITE + path;
  }
  return _get(path).then(function (html) {
      var srcs = [];
      var re = /<(?:iframe[^>]+src="([^"]*newplayer\.php[^"]*)"|[^>]+data-video="([^"]*newplayer\.php[^"]*)")/gi, m;
      while ((m = re.exec(html)) !== null) srcs.push(m[1] || m[2]);
      if (!srcs.length) throw new Error('GogoAnime: no player embed');
      var embed = srcs[0];
      for (var i = 0; i < srcs.length; i++) {
        if (srcs[i].indexOf('type=hd-1') >= 0) { embed = srcs[i]; break; }
      }
      if (embed.indexOf('//') === 0) embed = 'https:' + embed;
      return _resolveMegaplay(embed, ep);
    });
}

function _resolveMegaplay(embedUrl, referer) {
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
        if (!streamUrl) throw new Error('Embed has no stream frame: ' + embedUrl);
        if (streamUrl.indexOf('//') === 0) streamUrl = 'https:' + streamUrl;
      }
      return fetch(streamUrl, { headers: h(embedUrl) })
        .then(function (r) { return r.body || ''; })
        .then(function (streamBody) {
          var dataId = (streamBody.match(/data-id="(\d+)"/) || [])[1];
          if (!dataId) throw new Error('Stream player id not found');
          var o = streamUrl.match(/^(https?:\/\/[^/]+)/);
          var apiHost = o ? o[1] : streamUrl;
          return fetch(apiHost + '/stream/getSourcesNew?id=' + dataId + '&type=sub',
            { headers: h(streamUrl, true) }).then(function (r) { return r.json(); });
        });
    }).then(function (data) {
      if (!data || typeof data !== 'object') data = {};
      var file = _mpFile(data);
      if (!file) throw new Error('No stream file in embed response');
      var subs = [];
      var tracks = data.tracks || [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (!t || !t.file) continue;
        subs.push({ url: String(t.file), lang: String(t.label || t.kind || 'sub') });
      }
      var sk = { intro: data.intro || {}, outro: data.outro || {} };
      function num(v) { return (typeof v === 'number') ? v : null; }
      var headers = { 'User-Agent': UA, 'Referer': 'https://megaplay.buzz/' };
      var list = [{
        url: file,
        quality: 'Auto',
        container: 'hls',
        headers: headers,
        subtitles: subs,
        introStart: num(sk.intro.start), introEnd: num(sk.intro.end),
        outroStart: num(sk.outro.start), outroEnd: num(sk.outro.end)
      }];
      return fetch(file, { headers: headers }).then(function (r) { return r.text(); })
        .then(function (body) {
          var low = String(body || '').toLowerCase();
          if (low.indexOf('attention required') >= 0 || low.indexOf('just a moment') >= 0 ||
              low.indexOf('challenge-platform') >= 0 || low.indexOf('cf-error') >= 0) {
            throw new Error('GogoAnime: stream unreachable (cloudflare)');
          }
          return list;
        }).catch(function (e) {
          throw new Error('GogoAnime: stream unreachable (' + ((e && e.message) || e) + ')');
        });
    });
}
