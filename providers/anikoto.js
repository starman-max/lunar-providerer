// AniKoto — anime source for the Zangetsu provider repo (anikototv.to).
//
// anikototv.to is an aniwatch-style site. Streams are NOT keyed by the episode
// id — each episode carries an encrypted `data-ids` (server_ids) blob, and the
// real player is resolved through the site's own two-step server chain, then
// extracted from MegaPlay (AES-encrypted m3u8 + subtitle tracks):
//   /filter?keyword=            -> slug
//   /watch/<slug>               -> anime id (data-id) + metadata
//   /ajax/episode/list/<id>     -> [{ data-id, num, sub, dub, data-ids(server_ids) }]
//   /ajax/server/list?servers=<server_ids> -> server list (VidPlay/HD/Vidstream/…)
//   /ajax/server?get=<link_id>  -> { url: <megaplay embed>, skip_data }
//   megaplay.buzz/stream/getSources?id=<embed data-id> -> { tracks, enc } -> m3u8
//
// Home = /home spotlight (hero) + recent from the JSON API (anikotoapi.site);
// slugs are shared with the site, so those cards resolve through getDetail.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'anikoto';

var SITE = 'https://anikoto.cz';
var API = 'https://anikotoapi.site';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Hosts whose /stream/getSources returns a plain m3u8 (MegaPlay + its clone).
var MEGA_RE = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:megaplay\.[a-z]+|vidwish\.[a-z]+)/i;

function getInfo() {
  return { name: 'AniKoto', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.0.4' };
}

function _mode(opts) { return (opts && opts.category === 'dub') ? 'dub' : 'sub'; }

// GET a page as text. `xhr` sets the ajax header the /ajax routes expect.
function _get(url, ref, xhr) {
  var h = { 'User-Agent': UA, 'Referer': ref || SITE + '/' };
  if (xhr) h['X-Requested-With'] = 'XMLHttpRequest';
  return fetch(url, { headers: h })
    .then(function (r) { return r.body || ''; })
    .catch(function () { return ''; });
}
function _json(url, ref) {
  return _get(url, ref).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; } return j;
  });
}
// The site's /ajax routes wrap their payload in { status, result }. `result` is
// an HTML string (episode/server list) or an object (server?get).
function _ajax(path) {
  return _get(SITE + path, SITE + '/', true).then(function (b) {
    var j; try { j = JSON.parse(b || 'null'); } catch (e) { j = null; } return j;
  }).catch(function () { return null; });
}

function _year(s) { var m = String(s || '').match(/(19|20)\d{2}/); return m ? m[0] : null; }
function _slugFromWatch(href) {
  var m = String(href || '').match(/\/watch\/([^/"?#]+)/);
  return m ? m[1] : null;
}

// ── Search: scrape /filter?keyword= result cards ────────────────────────────
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1) return Promise.resolve([]);
  var url = SITE + '/filter?keyword=' + encodeURIComponent(q) + '&page=' + (page || 1);
  return _get(url, SITE + '/').then(function (html) {
    var out = [], seen = {};
    var chunks = html.split('<div class="item');
    for (var i = 1; i < chunks.length; i++) {
      var c = chunks[i];
      var slug = _slugFromWatch((c.match(/href="([^"]*\/watch\/[^"]+)"/) || [])[1]);
      if (!slug || seen[slug]) continue;
      var title = (c.match(/class="name d-title"[^>]*>([^<]+)</) || [])[1]
        || (c.match(/data-jp="([^"]+)"/) || [])[1];
      var poster = (c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
      if (!title) continue;
      seen[slug] = 1;
      out.push({ id: slug, title: htmlText(title).trim(), url: slug,
        cover: poster || null, type: 'anime', sourceId: SOURCE_ID });
    }
    return out;
  }).catch(function () { return []; });
}

// ── Home: /home spotlight (hero) + recent from the JSON API ──────────────────
function _apiCard(a) {
  if (!a || !a.slug) return null;
  return { id: a.slug, title: a.title || a.alternative || a.slug, url: a.slug,
    cover: a.poster || null, type: 'anime', sourceId: SOURCE_ID,
    subCount: a.is_sub ? 1 : 0, dubCount: 0 };
}
// Slice the /home page into its section containers (#hotest / #top-anime /
// #recent-update), each bounded by the next section so cards don't bleed across.
function _sections(html) {
  var ids = ['hotest', 'top-anime', 'recent-update'], marks = [];
  for (var i = 0; i < ids.length; i++) {
    var k = html.indexOf('id="' + ids[i] + '"');
    if (k >= 0) marks.push({ id: ids[i], at: k });
  }
  marks.sort(function (a, b) { return a.at - b.at; });
  var res = {};
  for (var j = 0; j < marks.length; j++) {
    var end = (j + 1 < marks.length) ? marks[j + 1].at : marks[j].at + 30000;
    res[marks[j].id] = html.substring(marks[j].at, end);
  }
  return res;
}
// Spotlight (#hotest) cards carry the title in an <h2 …d-title> + a bg-image.
function _spotlight(seg) {
  var out = [], seen = {}, chunks = seg.split('swiper-slide item');
  for (var i = 1; i < chunks.length; i++) {
    var c = chunks[i];
    var slug = _slugFromWatch((c.match(/href="([^"]*\/watch\/[^"]+)"/) || [])[1]);
    if (!slug || seen[slug]) continue;
    var title = (c.match(/class="title d-title"[^>]*>\s*([^<]+?)\s*</) || [])[1]
      || (c.match(/data-jp="([^"]+)"/) || [])[1];
    if (!title) continue;
    var img = (c.match(/background-image:\s*url\(([^)]+)\)/)
      || c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    if (img) img = img.replace(/^['"]|['"]$/g, '');
    seen[slug] = 1;
    out.push({ id: slug, title: htmlText(title).trim(), url: slug,
      cover: img || null, type: 'anime', sourceId: SOURCE_ID });
  }
  return out;
}
// Generic grid (#top-anime a.item, #recent-update div.item) → cards.
function _gridCards(seg) {
  var out = [], seen = {}, items = String(seg || '').split('class="item');
  for (var i = 1; i < items.length; i++) {
    var c = items[i];
    var slug = _slugFromWatch((c.match(/href="([^"]*\/watch\/[^"]+)"/) || [])[1]);
    if (!slug || seen[slug]) continue;
    var title = (c.match(/class="(?:name|title)[^"]*d-title"[^>]*>\s*([^<]+?)\s*</) || [])[1]
      || (c.match(/class="name"[^>]*>\s*([^<]+?)\s*</) || [])[1]
      || (c.match(/data-jp="([^"]+)"/) || [])[1];
    var poster = (c.match(/<img[^>]+data-src="([^"]+)"/) || c.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    if (!title) continue;
    seen[slug] = 1;
    out.push({ id: slug, title: htmlText(title).trim(), url: slug,
      cover: poster || null, type: 'anime', sourceId: SOURCE_ID });
  }
  return out;
}
function getHome(opts) {
  return _get(SITE + '/home', SITE + '/').then(function (html) {
    var s = _sections(html), rows = [];
    var spot = _spotlight(s.hotest || html);
    if (spot.length) rows.push({ title: 'Spotlight', items: spot });
    var top = _gridCards(s['top-anime']);
    if (top.length) rows.push({ title: 'Top Anime', items: top });
    var recent = _gridCards(s['recent-update']);
    if (recent.length) rows.push({ title: 'Recently Updated', items: recent });
    return rows;
  }).catch(function () { return []; }).then(function (rows) {
    if (rows.length) return rows;
    // Fallback: the JSON API's recent list if the /home scrape yielded nothing.
    return _json(API + '/recent-anime?page=1&per_page=24').then(function (j) {
      var data = (j && j.data) || [], items = [];
      for (var k = 0; k < data.length; k++) { var cc = _apiCard(data[k]); if (cc) items.push(cc); }
      return items.length ? [{ title: 'Recently Updated', items: items }] : [];
    }).catch(function () { return []; });
  });
}

// ── Detail + episodes ───────────────────────────────────────────────────────
function _cleanTitle(og) {
  var t = String(og || '');
  t = t.replace(/\s*[|-]\s*Anikoto.*$/i, '');        // trailing site name
  t = t.replace(/^Watch\s+/i, '').replace(/^Anime\s+/i, ''); // leading fluff
  t = t.replace(/\s+Anime\s+Online.*$/i, '');         // "X Anime Online …"
  t = t.replace(/\s+Watch\s+Online.*$/i, '');         // "X Watch Online Free"
  t = t.replace(/\s+Online\s+(with|free)\b.*$/i, ''); // "X Online with SUB/DUB"
  return t.trim();
}
function _genres(html) {
  var g = [], re = /href="[^"]*\/genre\/[^"]*"[^>]*>([^<]+)</g, m;
  while ((m = re.exec(html)) !== null && g.length < 8) {
    var t = htmlText(m[1]).trim(); if (t) g.push(t);
  }
  return g;
}

// Episode url: anikoto://<cat>/<encoded server_ids>/<sub><dub>/<num>. The player
// rewrites the leading <cat> segment for its Sub/Dub toggle; getVideoSources
// resolves the server list from the (per-episode) server_ids blob.
function _epUrl(cat, serverIds, sub, dub, num) {
  return 'anikoto://' + cat + '/' + encodeURIComponent(serverIds) + '/'
    + (sub ? 1 : 0) + (dub ? 1 : 0) + '/' + num;
}

function getDetail(url, opts) {
  var slug = String(url);
  var cat = _mode(opts);
  return _get(SITE + '/watch/' + encodeURIComponent(slug), SITE + '/').then(function (html) {
    var animeId = (html.match(/data-id="(\d+)"/) || [])[1];
    // The canonical clean title is the <h1 class="… d-title">; og:title is
    // marketing fluff ("Watch X Anime Online Free"), used only as a fallback.
    var title = htmlText((html.match(/<h1[^>]*class="[^"]*d-title[^"]*"[^>]*>([^<]+)<\/h1>/) || [])[1] || '').trim()
      || _cleanTitle((html.match(/og:title"\s+content="([^"]+)"/) || [])[1]) || slug;
    var poster = (html.match(/og:image"\s+content="([^"]+)"/) || [])[1] || null;
    var synopsis = (html.match(/class="synopsis[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
    var base = {
      id: slug, title: title, url: slug, cover: poster,
      description: htmlText(synopsis).trim(), status: 'unknown',
      genres: _genres(html), studios: [], type: 'anime', sourceId: SOURCE_ID,
      episodes: [], year: _year(html), malId: null, subCount: 0, dubCount: 0
    };
    if (!animeId) return base;
    return _ajax('/ajax/episode/list/' + animeId).then(function (j) {
      var lhtml = (j && typeof j.result === 'string') ? j.result : '';
      var out = [], subN = 0, dubN = 0, mal = null;
      var re = /<a\b([^>]*\bdata-id="\d+"[^>]*)>/g, m;
      while ((m = re.exec(lhtml)) !== null) {
        var attrs = m[1];
        var serverIds = (attrs.match(/data-ids="([^"]+)"/) || [])[1];
        if (!serverIds) continue; // no servers → not playable
        var num = parseInt((attrs.match(/data-num="(\d+)"/) || [])[1] || '0', 10);
        var sub = (attrs.match(/data-sub="(\d+)"/) || [])[1] === '1';
        var dub = (attrs.match(/data-dub="(\d+)"/) || [])[1] === '1';
        if (!sub && !dub) continue;
        if (!mal) mal = (attrs.match(/data-mal="(\d+)"/) || [])[1] || null;
        if (sub) subN++;
        if (dub) dubN++;
        var initCat = (cat === 'dub' && dub) || (cat === 'sub' && !sub && dub) ? 'dub' : 'sub';
        var title2 = (attrs.match(/title="([^"]+)"/) || [])[1];
        out.push({ id: cat + ':' + num, number: num,
          title: title2 ? htmlText(title2).trim() : ('Episode ' + num),
          url: _epUrl(initCat, serverIds, sub, dub, num) });
      }
      base.episodes = out;
      base.subCount = subN;
      base.dubCount = dubN;
      base.malId = mal ? parseInt(mal, 10) : null;
      return base;
    }).catch(function () { return base; });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

// ── Streams: server_ids → server list → server?get → MegaPlay getSources ─────
function _parseServers(html) {
  var servers = [], re = /data-type="(\w+)"([\s\S]*?)(?=data-type="|$)/g, tm;
  while ((tm = re.exec(html)) !== null) {
    var type = tm[1], block = tm[2], lm, lre = /data-link-id="([^"]+)"[^>]*>([^<]*)</g;
    while ((lm = lre.exec(block)) !== null) {
      servers.push({ type: type, linkId: lm[1], name: (lm[2] || '').trim() });
    }
  }
  return servers;
}
// Prefer MegaPlay-backed servers (Vidstream/HD → megaplay.buzz) — plain m3u8.
function _srvRank(name) {
  var n = String(name || '').toLowerCase();
  if (n.indexOf('vidstream') > -1) return 0;
  if (n.indexOf('hd') > -1) return 1;
  if (n.indexOf('vidcloud') > -1) return 2;
  return 5;
}

function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('anikoto://', '');
  var parts = raw.split('/');
  var cat = (parts[0] === 'dub') ? 'dub' : 'sub';
  var serverIds = parts[1] ? decodeURIComponent(parts[1]) : '';
  if (!serverIds) return Promise.reject(new Error('AniKoto: no server ids'));

  return _ajax('/ajax/server/list?servers=' + encodeURIComponent(serverIds)).then(function (j) {
    var lhtml = (j && typeof j.result === 'string') ? j.result : '';
    var servers = _parseServers(lhtml);
    var want = [];
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i];
      var ok = (cat === 'dub') ? (s.type === 'dub') : (s.type === 'sub' || s.type === 'hsub');
      if (ok) want.push(s);
    }
    if (!want.length) want = servers;
    want.sort(function (a, b) { return _srvRank(a.name) - _srvRank(b.name); });
    return _tryServers(want, 0, cat);
  });
}

// Resolve servers in preference order; take the first that yields a MegaPlay
// (or clone) embed, then extract its m3u8.
function _tryServers(list, i, cat) {
  if (i >= list.length) return Promise.reject(new Error('AniKoto: no playable server'));
  return _ajax('/ajax/server?get=' + encodeURIComponent(list[i].linkId)).then(function (j) {
    var url = j && j.result && (typeof j.result === 'object' ? j.result.url : null);
    if (url && MEGA_RE.test(url)) return _extractMega(url, cat);
    return _tryServers(list, i + 1, cat);
  }).catch(function () { return _tryServers(list, i + 1, cat); });
}

// ── Canonical MegaPlay `enc` decrypt (KEEP IN SYNC: anikoto.js / hianime.js;
// AES-CBC core mirrors hdhub4u.js). getSources returns { tracks, enc } — `enc`
// is base64url AES-256-CBC with the static key/IV from MegaPlay's own player
// bundle. Legacy { sources: { file } } responses are still accepted.
var _MEGA_KEY = 'i?LMTAx0Q6,:}50U';
var _MEGA_IV = "W0;27ToaUpl_P%'c";
var _SBOX=[0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
var _ISBOX=[0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d];
function _xtime(a){a<<=1;if(a&0x100)a^=0x11b;return a&0xff;}
function _gmul(a,b){var p=0;for(var i=0;i<8;i++){if(b&1)p^=a;var hi=a&0x80;a=(a<<1)&0xff;if(hi)a^=0x1b;b>>=1;}return p&0xff;}
function _keyExp(key){
  var Nk=key.length/4,Nr=Nk+6,w=[],i;
  for(i=0;i<Nk;i++)w.push([key[4*i],key[4*i+1],key[4*i+2],key[4*i+3]]);
  var rcon=1;
  for(i=Nk;i<4*(Nr+1);i++){
    var t=w[i-1].slice();
    if(i%Nk===0){t=[t[1],t[2],t[3],t[0]];t=[_SBOX[t[0]],_SBOX[t[1]],_SBOX[t[2]],_SBOX[t[3]]];t[0]^=rcon;rcon=_xtime(rcon);}
    else if(Nk>6&&i%Nk===4){t=[_SBOX[t[0]],_SBOX[t[1]],_SBOX[t[2]],_SBOX[t[3]]];}
    w.push([w[i-Nk][0]^t[0],w[i-Nk][1]^t[1],w[i-Nk][2]^t[2],w[i-Nk][3]^t[3]]);
  }
  return {w:w,Nr:Nr};
}
function _invCipher(inb,ks){
  var w=ks.w,Nr=ks.Nr,s=[[],[],[],[]],r,c,i;
  for(i=0;i<16;i++)s[i%4][(i/4)|0]=inb[i];
  function ark(round){for(c=0;c<4;c++)for(r=0;r<4;r++)s[r][c]^=w[round*4+c][r];}
  function isub(){for(r=0;r<4;r++)for(c=0;c<4;c++)s[r][c]=_ISBOX[s[r][c]];}
  function ishift(){for(r=1;r<4;r++){var row=s[r].slice();for(c=0;c<4;c++)s[r][c]=row[(c-r+4)%4];}}
  function imix(){for(c=0;c<4;c++){var a0=s[0][c],a1=s[1][c],a2=s[2][c],a3=s[3][c];
    s[0][c]=_gmul(a0,14)^_gmul(a1,11)^_gmul(a2,13)^_gmul(a3,9);
    s[1][c]=_gmul(a0,9)^_gmul(a1,14)^_gmul(a2,11)^_gmul(a3,13);
    s[2][c]=_gmul(a0,13)^_gmul(a1,9)^_gmul(a2,14)^_gmul(a3,11);
    s[3][c]=_gmul(a0,11)^_gmul(a1,13)^_gmul(a2,9)^_gmul(a3,14);}}
  ark(Nr);
  for(var round=Nr-1;round>=1;round--){ishift();isub();ark(round);imix();}
  ishift();isub();ark(0);
  var out=[];for(i=0;i<16;i++)out[i]=s[i%4][(i/4)|0];return out;
}
function _aesCbcDecrypt(ct,key,iv){
  var ks=_keyExp(key),out=[],prev=iv.slice(),off,i;
  for(off=0;off+16<=ct.length;off+=16){
    var block=ct.slice(off,off+16),dec=_invCipher(block,ks);
    for(i=0;i<16;i++)out.push(dec[i]^prev[i]);
    prev=block;
  }
  var pad=out[out.length-1];
  if(pad>0&&pad<=16)out=out.slice(0,out.length-pad);
  return out;
}
function _strBytes(s){var b=[];for(var i=0;i<s.length;i++)b.push(s.charCodeAt(i)&0xff);return b;}
function _bytesToStr(b){var s='',i=0;while(i<b.length){var c=b[i++];if(c<0x80)s+=String.fromCharCode(c);else if(c<0xE0)s+=String.fromCharCode(((c&0x1f)<<6)|(b[i++]&0x3f));else if(c<0xF0)s+=String.fromCharCode(((c&0x0f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f));else{var cp=((c&0x07)<<18)|((b[i++]&0x3f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f);cp-=0x10000;s+=String.fromCharCode(0xD800+(cp>>10),0xDC00+(cp&0x3FF));}}return s;}
function _megaB64Url(s){
  var t=String(s||'').replace(/-/g,'+').replace(/_/g,'/');
  while(t.length%4)t+='=';
  try { return Array.prototype.slice.call(base64ToBytes(t)); } catch(e){ return []; }
}
function _megaPad(s,len){var b=_strBytes(s),o=[];for(var i=0;i<len;i++)o.push(i<b.length?b[i]:0);return o;}
function _megaDecFile(enc){
  var ct=_megaB64Url(enc);
  if(!ct.length||ct.length%16)return null;
  try{
    var pt=_bytesToStr(_aesCbcDecrypt(ct,_megaPad(_MEGA_KEY,32),_megaPad(_MEGA_IV,16)));
    var m=pt.match(/"file"\s*:\s*"([^"]+)"/);
    return m?m[1].replace(/\\\//g,'/'):null;
  }catch(e){return null;}
}
// Single choke point for the stream file: legacy plain `sources.file` first,
// then the current AES `enc` payload. Returns the file URL or null.
function _megaFile(j){
  var s=j&&j.sources;
  var f=s?(s.file||(s[0]&&s[0].file)):null;
  if(f)return f;
  if(j&&j.enc)return _megaDecFile(j.enc);
  return null;
}

// MegaPlay embed page → data-id → getSources (m3u8 + subtitle tracks).
function _extractMega(embed, cat) {
  var base = (embed.match(/^(https?:\/\/[^/]+)/) || [])[1] || 'https://megaplay.buzz';
  return _get(embed, SITE + '/').then(function (mhtml) {
    var dataId = (mhtml.match(/data-id="(\d+)"/) || [])[1];
    if (!dataId) throw new Error('AniKoto: no MegaPlay id');
    return fetch(base + '/stream/getSources?id=' + dataId, {
      headers: { 'User-Agent': UA, 'Referer': embed, 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (r) {
      var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { throw new Error('AniKoto: bad getSources'); }
      var file = _megaFile(j);
      if (!file) throw new Error('AniKoto: no stream file');
      var subs = [];
      var tracks = (j && j.tracks) || [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (!t || !t.file) continue;
        if (t.kind && t.kind !== 'captions' && t.kind !== 'subtitles') continue;
        subs.push({ url: t.file, lang: t.label || 'Sub', label: t.label || 'Sub',
          format: /\.srt(\?|$)/i.test(t.file) ? 'srt' : 'vtt', 'default': !!t['default'] });
      }
      var hdrs = { 'User-Agent': UA, 'Referer': base + '/', 'Origin': base };
      var mk = function (u, q) {
        return { url: u, quality: q, container: /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'mp4',
          headers: hdrs, kind: cat, audioLang: cat === 'dub' ? 'en' : 'ja', subtitles: subs };
      };
      if (!/\.m3u8(\?|$)/i.test(file)) return [mk(file, 'auto')];
      return fetch(file, { headers: { 'User-Agent': UA, 'Referer': base + '/' } }).then(function (mr) {
        var body = mr.body || '';
        var dir = file.replace(/[^/]*(\?.*)?$/, '');
        var vs = [], m2, re = /#EXT-X-STREAM-INF:[^\n]*?RESOLUTION=\d+x(\d+)[^\n]*\r?\n([^\r\n#]+)/gi;
        while ((m2 = re.exec(body)) !== null) {
          var h = parseInt(m2[1], 10);
          var uri = String(m2[2]).replace(/^\s+|\s+$/g, '');
          if (!uri) continue;
          vs.push({ h: h, url: /^https?:/i.test(uri) ? uri : (dir + uri) });
        }
        vs.sort(function (a, b) { return b.h - a.h; });
        var outv = [mk(file, 'auto')];
        for (var k = 0; k < vs.length; k++) outv.push(mk(vs[k].url, vs[k].h + 'p'));
        return outv;
      }).catch(function () { return [mk(file, 'auto')]; });
    });
  });
}
