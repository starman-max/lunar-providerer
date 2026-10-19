// HiAnime — anime source for the Zangetsu provider repo (hianimes.se).
//
// hianimes.se is a Next.js front-end over a JSON API at animedata.cfd. The API
// hands us episode "player" links (animeplay.cfd / megaplay.buzz / zokoanime);
// MegaPlay's getSources returns an AES-encrypted m3u8 (`enc`) + subtitle tracks,
// so the chain is API/JSON + one regex hop for the player file id + decrypt:
//   search/home/detail/episodes (animedata.cfd/api)  ->  episode player link(s)
//   ->  megaplay.buzz data-id  ->  /stream/getSources?id=  ->  m3u8 + subs.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'hianime';

var API = 'https://aniwatchbackend.cfd/api';
var SITE = 'https://hianimes.se';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function getInfo() {
  return { name: 'HiAnime', lang: 'en', baseUrl: SITE,
    logo: SITE + '/favicon.ico', type: 'anime', version: '1.1.1' };
}

function _mode(opts) { return (opts && opts.category === 'dub') ? 'dub' : 'sub'; }

function _api(path) {
  return fetch(API + path, { headers: { 'User-Agent': UA, 'Referer': SITE + '/' } })
    .then(function (r) { var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { j = null; } return j; })
    .catch(function () { return null; });
}
function _get(url, ref) {
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || SITE + '/' } })
    .then(function (r) { return r.body || ''; }).catch(function () { return ''; });
}
function _year(s) { var m = String(s || '').match(/(19|20)\d{2}/); return m ? m[0] : null; }

// The /episodes endpoint returns only the first 100; `?start=N` returns the
// rest (uncapped). Page through until we've collected `total` episodes so long
// anime (One Piece, Naruto, ...) aren't capped at 100.
function _allEpisodes(id) {
  return _api('/episodes/' + encodeURIComponent(id)).then(function (e) {
    var all = (e && e.episodes) || [];
    var total = (e && typeof e.total === 'number') ? e.total : all.length;
    function finish() {
      all.sort(function (x, y) { return (x.episodeNumber || 0) - (y.episodeNumber || 0); });
      return all;
    }
    function more(depth) {
      if (all.length >= total || depth > 40) return finish();
      var start = all.length + 1;
      return _api('/episodes/' + encodeURIComponent(id) + '?start=' + start).then(function (e2) {
        var batch = (e2 && e2.episodes) || [];
        var have = {};
        for (var i = 0; i < all.length; i++) have[all[i].episodeNumber] = 1;
        var added = 0;
        for (var k = 0; k < batch.length; k++) {
          var ep = batch[k];
          if (ep && !have[ep.episodeNumber]) { all.push(ep); added++; }
        }
        if (added === 0) return finish();
        return more(depth + 1);
      }).catch(function () { return finish(); });
    }
    return more(0);
  }).catch(function () { return []; });
}
function _genres(a) {
  var g = a.genres || [];
  return g.map(function (x) { return typeof x === 'string' ? x : (x && (x.name || x.title)); })
          .filter(Boolean).slice(0, 6);
}

// ── Episode thumbnails (Kitsu, keyed by the anime's mal_id) ──────────────────
// The API gives no per-episode image, so the app falls back to the series
// poster. Kitsu has broad per-episode thumbnails (incl. older anime) and is
// reachable where TMDB is ISP-blocked. Map mal_id -> Kitsu id, then page its
// episodes. Strictly best-effort: any failure leaves the poster fallback and
// never affects playback. Returns { episodeNumber: thumbnailUrl }.
function _kitsuStills(malId) {
  if (!malId) return Promise.resolve({});
  var H = { 'Accept': 'application/vnd.api+json', 'User-Agent': UA };
  var mapUrl = 'https://kitsu.io/api/edge/mappings?filter%5BexternalSite%5D=myanimelist/anime'
    + '&filter%5BexternalId%5D=' + encodeURIComponent(malId) + '&include=item';
  return fetch(mapUrl, { headers: H, timeoutMs: 8000 }).then(function (r) {
    var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { return {}; }
    var inc = (j && j.included) || [];
    var kid = null;
    for (var i = 0; i < inc.length; i++) {
      if (inc[i] && inc[i].type === 'anime') { kid = inc[i].id; break; }
    }
    if (!kid) return {};
    var map = {};
    function page(off, depth) {
      if (depth > 8) return map;
      var u = 'https://kitsu.io/api/edge/anime/' + kid +
        '/episodes?page%5Blimit%5D=20&page%5Boffset%5D=' + off;
      return fetch(u, { headers: H, timeoutMs: 8000 }).then(function (r2) {
        var d; try { d = JSON.parse(r2.body || 'null'); } catch (e) { return map; }
        var eps = (d && d.data) || [];
        for (var k = 0; k < eps.length; k++) {
          var at = eps[k].attributes || {};
          var th = at.thumbnail && at.thumbnail.original;
          if (at.number != null && th) map[at.number] = th;
        }
        if (eps.length < 20) return map;
        return page(off + 20, depth + 1);
      }).catch(function () { return map; });
    }
    return page(0, 0);
  }).catch(function () { return {}; });
}

// One API anime object → a Zangetsu card. Detail is keyed by a slug; home/detail
// objects expose `slug` (string), search results expose `slugs` (array).
function _slugOf(a) {
  if (a.slug) return a.slug;
  if (Array.isArray(a.slugs) && a.slugs.length) return a.slugs[0];
  if (typeof a.slugs === 'string') return a.slugs;
  return null;
}
function _card(a) {
  if (!a) return null;
  var inner = a.anime || a; // home rows sometimes wrap the anime
  var slug = inner && _slugOf(inner);
  if (!slug) return null;
  return {
    id: slug, title: inner.English || inner.title || inner.Japanese || 'Untitled',
    englishTitle: inner.English || null, cover: inner.image || inner.landScapeImage || null,
    url: slug, type: 'anime', sourceId: SOURCE_ID,
    subCount: inner.totalSub || inner.totalSubbed || 0,
    dubCount: inner.totalDub || inner.totalDubbed || 0
  };
}
function _cards(list) {
  var out = []; list = list || [];
  for (var i = 0; i < list.length; i++) { var c = _card(list[i]); if (c) out.push(c); }
  return out;
}

// Search is a POST to /search with a JSON {title} body; returns an array.
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 2) return Promise.resolve([]);
  return fetch(API + '/search', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Referer': SITE + '/', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: q })
  }).then(function (r) {
    var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { j = null; }
    var list = Array.isArray(j) ? j : ((j && (j.animes || j.results || j.data)) || []);
    return _cards(list);
  }).catch(function () { return []; });
}

// Each /home row is either an array (featured) or an {animes:[...]} object
// (trending/popular/...) — normalise to the underlying list.
function _rowItems(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.animes)) return v.animes;
  if (v && Array.isArray(v.results)) return v.results;
  if (v && Array.isArray(v.data)) return v.data;
  return [];
}

function getHome(opts) {
  return _api('/home').then(function (j) {
    if (!j) return [];
    var rows = [
      { title: 'Trending', key: 'trending' },
      { title: 'Popular', key: 'popular' },
      { title: 'Currently Airing', key: 'currentlyAiring' },
      { title: 'Latest', key: 'latestAnime' },
      { title: 'Recently Completed', key: 'finishedAiring' }
    ];
    var out = rows.map(function (r) { return { title: r.title, items: _cards(_rowItems(j[r.key])) }; })
                  .filter(function (r) { return r.items.length; });
    // The app uses the FIRST section as the hero carousel, so make sure it has
    // several items: lead with the featured spotlight, then trending.
    var feat = _cards(_rowItems(j.featured));
    if (out.length) {
      var seen = {}, merged = [];
      feat.concat(out[0].items).forEach(function (c) { if (c && !seen[c.id]) { seen[c.id] = 1; merged.push(c); } });
      out[0] = { title: out[0].title, items: merged };
    } else if (feat.length) {
      out = [{ title: 'Spotlight', items: feat }];
    }
    return out;
  }).catch(function () { return []; });
}

// The API ships several player links per episode/language (zokoanime,
// megaplay, animeplay). Only MegaPlay-backed ones are extractable, so prefer
// the first MegaPlay-ish link — one picker used for both languages.
function _pickPlayer(links) {
  links = links || [];
  for (var i = 0; i < links.length; i++) {
    if (/megaplay|vidwish|animeplay/i.test(links[i] || '')) return links[i];
  }
  return links[0] || '';
}

// Episode url packs the category FIRST as a `/sub//dub/` PATH segment (so the
// player's in-place Sub/Dub switch — which rewrites that segment — actually
// works), then BOTH the sub and dub player links so getVideoSources resolves
// whichever language the player asks for, with no re-fetch. The old `cat|link`
// form had no `/sub//dub/` segment, so switching to Dub re-resolved the SAME
// sub link ("changed dub, still sub").
function _epUrl(cat, subP, dubP, n) {
  return 'hianime://' + cat + '/' + encodeURIComponent(subP || '') + '/'
    + encodeURIComponent(dubP || '') + '/' + n;
}

function getDetail(url, opts) {
  var slug = String(url);
  var cat = _mode(opts);
  return _api('/anime/' + encodeURIComponent(slug)).then(function (j) {
    var a = (j && (j.anime || j)) || {};
    var id = a._id;
    var base = {
      id: slug, title: a.English || a.title || slug, englishTitle: a.English || null,
      cover: a.image || a.landScapeImage || null, url: slug,
      description: htmlText(a.synopsis || ''), status: a.Status || 'unknown',
      genres: _genres(a), studios: [], type: 'anime', sourceId: SOURCE_ID,
      episodes: [], year: _year(a.Aired),
      // MAL id drives tracker sync (AniList/MAL/Simkl) in the app.
      malId: (a.mal_id != null) ? parseInt(a.mal_id, 10) : null,
      // The detail object uses totalSub/totalDub (NOT totalSubbed/totalDubbed);
      // overridden below with exact counts from the episode links.
      subCount: a.totalSub || a.totalSubbed || 0,
      dubCount: a.totalDub || a.totalDubbed || 0
    };
    if (!id) return base;
    return _allEpisodes(id).then(function (eps) {
      if (!eps.length && a.episodes) eps = a.episodes;
      // Exact sub/dub availability comes from the episodes' link sets — this
      // drives the player's Sub/Dub toggle and the download sheet's chips.
      var subN = 0, dubN = 0;
      for (var ci = 0; ci < eps.length; ci++) {
        var lk = (eps[ci] && eps[ci].link) || {};
        if (lk.sub && lk.sub.length) subN++;
        if (lk.dub && lk.dub.length) dubN++;
      }
      if (eps.length) { base.subCount = subN; base.dubCount = dubN; }
      var out = [];
      for (var i = 0; i < eps.length; i++) {
        var ep = eps[i];
        var elk = ep.link || {};
        var subP = _pickPlayer(elk.sub || []);
        var dubP = _pickPlayer(elk.dub || []);
        if (!subP && !dubP) continue; // no stream at all
        var n = ep.episodeNumber != null ? ep.episodeNumber : (i + 1);
        // Lead with the requested category when it has a link (so playback
        // opens in the right language); the player can flip to the other.
        var initCat = ((cat === 'dub' && dubP) || (cat === 'sub' && !subP))
          ? 'dub' : 'sub';
        out.push({ id: cat + ':' + n, number: n,
          title: ep.title || ('Episode ' + n), url: _epUrl(initCat, subP, dubP, n) });
      }
      base.episodes = out;
      // Best-effort: fill in real episode stills from Jikan by mal_id. Never
      // blocks or changes ids/numbers/urls — only adds `thumbnail` where found.
      return _kitsuStills(a.mal_id).then(function (stills) {
        if (stills) {
          for (var k = 0; k < out.length; k++) {
            var still = stills[out[k].number];
            if (still) out[k].thumbnail = still;
          }
        }
        return base;
      }).catch(function () { return base; });
    }).catch(function () { return base; });
  });
}

function getEpisodes(url, opts) { return getDetail(url, opts).then(function (d) { return d.episodes; }); }

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

// Try every candidate player link in order (requested language first); the API
// usually ships several per episode (zokoanime + megaplay) and any single one
// can be down. One shared resolve path — no per-link branches.
function getVideoSources(episodeUrl) {
  var raw = String(episodeUrl).replace('hianime://', '');
  var cat, cands = [];
  if (raw.indexOf('|') > -1) {
    // Legacy url (hianime://<cat>|<encPlayer>) — keep old Continue-Watching /
    // resume entries playable.
    var cut = raw.indexOf('|');
    cat = (raw.slice(0, cut) === 'dub') ? 'dub' : 'sub';
    var legacy = decodeURIComponent(raw.slice(cut + 1));
    if (legacy) cands.push(legacy);
  } else {
    // hianime://<cat>/<encSubPlayer>/<encDubPlayer>/<num> — the player rewrites
    // the leading segment for its Sub/Dub toggle; resolve whichever language
    // was asked for, falling back to the other link.
    var parts = raw.split('/');
    cat = (parts[0] === 'dub') ? 'dub' : 'sub';
    var subP = parts[1] ? decodeURIComponent(parts[1]) : '';
    var dubP = parts[2] ? decodeURIComponent(parts[2]) : '';
    var first = (cat === 'dub' ? dubP : subP) || subP || dubP;
    var second = (first === subP) ? dubP : subP;
    if (first) cands.push(first);
    if (second && second !== first) cands.push(second);
  }
  if (!cands.length) return Promise.reject(new Error('HiAnime: no player link'));
  return _tryPlayers(cands, 0, cat);
}

function _tryPlayers(list, i, cat) {
  if (i >= list.length) return Promise.reject(new Error('HiAnime: no playable player link'));
  return _resolvePlayer(list[i], cat).catch(function () { return _tryPlayers(list, i + 1, cat); });
}

function _resolvePlayer(player, cat) {

  return _get(player, SITE + '/').then(function (html) {
    // animeplay.cfd wraps an iframe to the real megaplay player; megaplay links
    // are already the player page.
    var mega = player;
    var ifr = (html.match(/<iframe[^>]+src="([^"]*megaplay[^"]*)"/i) ||
               html.match(/<iframe[^>]+src="([^"]+)"/i) || [])[1];
    if (ifr && ifr.indexOf('megaplay') !== -1) mega = absUrl(ifr, player);

    var pagePromise = (mega === player) ? Promise.resolve(html) : _get(mega, player);
    return pagePromise.then(function (mhtml) {
      var dataId = (mhtml.match(/data-id="(\d+)"/i) || [])[1];
      if (!dataId) throw new Error('HiAnime: no MegaPlay id');
      var base = (mega.match(/^(https?:\/\/[^/]+)/) || [])[1] || 'https://megaplay.buzz';
      return fetch(base + '/stream/getSources?id=' + dataId, {
        headers: { 'User-Agent': UA, 'Referer': mega, 'X-Requested-With': 'XMLHttpRequest' }
      }).then(function (r) {
        var j; try { j = JSON.parse(r.body || 'null'); } catch (e) { throw new Error('HiAnime: bad getSources'); }
        var file = _megaFile(j);
        if (!file) throw new Error('HiAnime: no stream file');
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
        // Adaptive master playlist → expose each rendition so the player shows a
        // real quality menu (plus "auto" for adaptive switching).
        return fetch(file, { headers: { 'User-Agent': UA, 'Referer': base + '/' } }).then(function (mr) {
          var body = mr.body || '';
          var dir = file.replace(/[^/]*(\?.*)?$/, '');
          var vs = [], m, re = /#EXT-X-STREAM-INF:[^\n]*?RESOLUTION=\d+x(\d+)[^\n]*\r?\n([^\r\n#]+)/gi;
          while ((m = re.exec(body)) !== null) {
            var h = parseInt(m[1], 10);
            var uri = String(m[2]).replace(/^\s+|\s+$/g, '');
            if (!uri) continue;
            vs.push({ h: h, url: /^https?:/i.test(uri) ? uri : (dir + uri) });
          }
          vs.sort(function (a, b) { return b.h - a.h; });
          var out = [mk(file, 'auto')];
          for (var i = 0; i < vs.length; i++) out.push(mk(vs[i].url, vs[i].h + 'p'));
          return out;
        }).catch(function () { return [mk(file, 'auto')]; });
      });
    });
  });
}
