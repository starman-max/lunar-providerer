// AnimeX — Lunar's own anime provider (animex.one), ported from
// lib/data/extension_engine/scrapers/scraper_impls.dart (AnimexScraper).
// Pure JSON APIs, no HTML scraping, no browser needed:
//   graphql.animex.one/graphql  searchAnime / anime(anilistId)
//   pp.animex.one/rest/api      episodes / servers / sources
// NOTE: never send `Origin: pp.animex.one` (403s); the animex.one origin
// (or no Origin at all) answers 200.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'animex';

var SITE = 'https://animex.one';
var API = 'https://pp.animex.one/rest/api';
var GQL = 'https://graphql.animex.one/graphql';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
var STREAM_REFERER = 'https://megaplay.buzz/';
var STREAM_ORIGIN = 'https://megaplay.buzz';

function getInfo() {
  return {
    name: 'AnimeX',
    lang: 'en',
    baseUrl: SITE,
    type: 'anime',
    version: '1.0.1'
  };
}

function _jsonHeaders() {
  return {
    'User-Agent': UA,
    'Referer': SITE + '/',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest'
  };
}

function _gql(query, variables) {
  return fetch(GQL, {
    method: 'POST',
    headers: _jsonHeaders(),
    body: JSON.stringify({ query: query, variables: variables || {} })
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (!data || typeof data !== 'object') throw new Error('AnimeX: non-graphql response');
    if (data.errors && data.errors.length) {
      throw new Error('AnimeX graphql: ' + ((data.errors[0] && data.errors[0].message) || 'unknown'));
    }
    if (!data.data || typeof data.data !== 'object') throw new Error('AnimeX: empty graphql data');
    return data.data;
  });
}

function _poster(cover) {
  if (!cover) return '';
  if (typeof cover === 'string') return cover;
  return cover.extraLarge || cover.large || cover.medium || '';
}

var _SEARCH_QUERY = 'query($q: String, $limit: Int) {'
  + ' searchAnime(query: $q, limit: $limit) {'
  + ' items { id anilistId titleRomaji titleEnglish format status episodeCount coverImage'
  + ' seasons { animeId anilistId titleRomaji titleEnglish format episodeCount coverImage }'
  + ' } } }';

function _addNode(out, seen, node) {
  if (!node || typeof node !== 'object') return;
  var id = String(node.animeId || node.id || '');
  if (!id || seen[id]) return;
  seen[id] = 1;
  var en = String(node.titleEnglish || '').trim();
  var rom = String(node.titleRomaji || '').trim();
  out.push({
    id: id,
    title: en || rom || id,
    url: 'animex:' + id,
    cover: _poster(node.coverImage),
    type: node.format ? String(node.format) : 'anime',
    sourceId: SOURCE_ID
  });
}

// Search + season fan-out: each node becomes one result keyed by its
// provider slug (`animex:<slug>`), so episodes resolve without a
// detail-page round trip.
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (!q) return Promise.resolve([]);
  return _gql(_SEARCH_QUERY, { q: q, limit: 25 }).then(function (data) {
    var conn = data.searchAnime || {};
    var items = conn.items || [];
    var out = [], seen = {};
    for (var i = 0; i < items.length; i++) {
      _addNode(out, seen, items[i]);
      var seasons = (items[i] && items[i].seasons) || [];
      for (var s = 0; s < seasons.length; s++) _addNode(out, seen, seasons[s]);
    }
    return out;
  }).catch(function () { return []; });
}

// Site slug -> provider slug. Accepts `animex:<slug>`, a detail/watch URL
// (its `-{anilistId}` suffix is looked up on GraphQL), or a page whose
// embedded `slug:"..."` is read directly.
function _resolveSlug(animeUrl) {
  var u = String(animeUrl || '').trim();
  if (!u) return Promise.reject(new Error('AnimeX: empty anime url'));
  if (u.indexOf('animex:') === 0) {
    var slug = u.substring('animex:'.length).split(':')[0].trim();
    if (slug) return Promise.resolve(slug);
    return Promise.reject(new Error('AnimeX: empty slug in "' + animeUrl + '"'));
  }
  var noTrail = u.split('?')[0].replace(/\/+$/, '');
  var m = noTrail.match(/-(\d+)$/);
  var anilistId = m ? parseInt(m[1], 10) : 0;
  function viaHtml() {
    var page = u.indexOf('http') === 0 ? u : SITE + (u.charAt(0) === '/' ? u : '/' + u);
    return fetch(page, { headers: _jsonHeaders(), timeoutMs: 10000 }).then(function (r) { return r.body || ''; })
      .then(function (body) {
        var hit = body.match(/slug:"([^"]+)"/);
        if (hit && hit[1]) return hit[1];
        throw new Error('AnimeX: no provider id for "' + animeUrl + '"');
      });
  }
  if (!anilistId) return viaHtml();
  return _gql('query($id: Int) { anime(anilistId: $id) { id } }', { id: anilistId })
    .then(function (data) {
      if (data.anime && data.anime.id) return String(data.anime.id);
      return viaHtml();
    }).catch(function () { return viaHtml(); });
}

function _epTitle(e, n) {
  var titles = e.titles || {};
  var v = String(titles.en || titles['en-US'] || titles.English || '').trim();
  return v || ('Episode ' + n);
}

function getEpisodes(url, opts) {
  return _resolveSlug(url).then(function (slug) {
    return fetch(API + '/episodes?id=' + encodeURIComponent(slug), { headers: _jsonHeaders(), timeoutMs: 10000 })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        if (!list || !list.length) throw new Error('AnimeX: no episodes');
        var eps = [];
        for (var i = 0; i < list.length; i++) {
          var e = list[i];
          if (!e) continue;
          var n = (typeof e.number === 'number') ? e.number : (parseInt(e.number, 10) || 0);
          if (n <= 0) continue;
          eps.push({
            id: 'animex:' + slug + ':' + n,
            number: n,
            title: _epTitle(e, n),
            url: 'animex:' + slug + ':' + n,
            isFiller: e.isFiller === true
          });
        }
        eps.sort(function (a, b) { return a.number - b.number; });
        return eps;
      });
  });
}

function getDetail(url, opts) {
  return _resolveSlug(url).then(function (slug) {
    return getEpisodes('animex:' + slug, opts).then(function (eps) {
      var pretty = slug.replace(/-[a-z0-9]+$/i, '').replace(/-/g, ' ').trim() || slug;
      return {
        id: 'animex:' + slug,
        title: pretty,
        cover: null,
        url: 'animex:' + slug,
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
  });
}

function _resolveEpisode(episodeUrl) {
  var u = String(episodeUrl || '').trim();
  if (u.indexOf('animex:') === 0) {
    var parts = u.substring('animex:'.length).split(':');
    var slug = (parts[0] || '').trim();
    var ep = parts.length > 1 ? parseInt((parts[1] || '').trim(), 10) : 0;
    if (slug && ep > 0) return Promise.resolve({ slug: slug, ep: ep });
    return Promise.reject(new Error('AnimeX: bad episode key "' + episodeUrl + '"'));
  }
  var m = u.match(/-episode-(\d+)/);
  if (m) {
    var epNum = parseInt(m[1], 10);
    return _resolveSlug(u.split('-episode-')[0]).then(function (slug) {
      return { slug: slug, ep: epNum };
    });
  }
  return Promise.reject(new Error('AnimeX: cannot parse episode url "' + episodeUrl + '"'));
}

// Servers -> provider id -> /sources. Proven chains (yuki/zuna) first;
// sora is last resort (its segment hosts are Cloudflare-walled from many
// networks — a payload alone doesn't mean playable, hence the preflight).
function getVideoSources(episodeUrl, opts) {
  var isDub = !!(opts && opts.dub);
  var kind = isDub ? 'dub' : 'sub';
  return _resolveEpisode(episodeUrl).then(function (key) {
    return fetch(API + '/servers?id=' + encodeURIComponent(key.slug) + '&epNum=' + key.ep,
        { headers: _jsonHeaders(), timeoutMs: 10000 })
      .then(function (r) { return r.json(); })
      .catch(function () { return {}; })
      .then(function (data) {
        var raw = (data && (isDub ? data.dubProviders : data.subProviders)) || [];
        var providers = [];
        for (var i = 0; i < raw.length; i++) {
          if (raw[i] && raw[i].id) providers.push(String(raw[i].id));
        }
        if (!providers.length) providers = ['yuki', 'zuna', 'sora'];
        var ordered = [];
        var pi;
        for (pi = 0; pi < ['yuki', 'zuna'].length; pi++) {
          if (providers.indexOf(['yuki', 'zuna'][pi]) >= 0) ordered.push(['yuki', 'zuna'][pi]);
        }
        for (pi = 0; pi < providers.length; pi++) {
          if (providers[pi] !== 'yuki' && providers[pi] !== 'zuna') ordered.push(providers[pi]);
        }
        // Try providers in order, first preflight-passing payload wins.
        var chain = Promise.reject(new Error('start'));
        ordered.forEach(function (providerId) {
          chain = chain.catch(function () { return _sourcesFor(key, kind, providerId); });
        });
        return chain.catch(function (e) {
          if (String((e && e.message) || e) === 'start') throw new Error('AnimeX: no playable source');
          throw e;
        });
      });
  });
}

function _sourcesFor(key, kind, providerId) {
  var url = API + '/sources?id=' + encodeURIComponent(key.slug)
    + '&epNum=' + key.ep + '&type=' + kind + '&providerId=' + encodeURIComponent(providerId);
  return fetch(url, { headers: _jsonHeaders(), timeoutMs: 10000 }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || typeof data !== 'object') throw new Error('AnimeX: bad sources payload (' + providerId + ')');
      var raw = data.sources || [];
      if (!raw.length) throw new Error('AnimeX: no sources (' + providerId + ')');
      var hdr = data.headers || {};
      var headers = {
        'User-Agent': UA,
        'Referer': hdr.Referer || STREAM_REFERER,
        'Origin': hdr.Origin || STREAM_ORIGIN,
        'Accept': '*/*'
      };
      var sources = [];
      for (var i = 0; i < raw.length; i++) {
        var s = raw[i];
        if (!s || !s.url) continue;
        var declared = String(s.type || '').toLowerCase();
        var q = String(s.quality || '').trim();
        sources.push({
          quality: (!q || q.toLowerCase() === 'auto') ? 'Auto' : q,
          url: String(s.url),
          type: declared.indexOf('mp4') >= 0 ? 'mp4' : 'hls'
        });
      }
      if (!sources.length) throw new Error('AnimeX: empty source urls (' + providerId + ')');
      var subtitles = [];
      var tracks = data.tracks || [];
      for (var t = 0; t < tracks.length; t++) {
        var tr = tracks[t];
        var tu = tr && (tr.url || tr.file);
        if (!tu || String(tu).indexOf('http') !== 0) continue;
        subtitles.push({ url: String(tu), lang: String(tr.label || tr.lang || tr.id || 'sub') });
      }
      var introStart, introEnd, outroStart, outroEnd;
      var chapters = data.chapters || [];
      for (var c = 0; c < chapters.length; c++) {
        var ch = chapters[c];
        if (typeof ch.start !== 'number' || typeof ch.end !== 'number') continue;
        var title = String(ch.title || '').toLowerCase();
        if (title.indexOf('intro') >= 0 || title.indexOf('opening') >= 0) {
          introStart = ch.start; introEnd = ch.end;
        } else if (title.indexOf('outro') >= 0 || title.indexOf('ending') >= 0 || title.indexOf('credit') >= 0) {
          outroStart = ch.start; outroEnd = ch.end;
        }
      }
      // Flat list shape the runtime consumes (one entry per rendition,
      // headers + subtitles attached to each).
      var list = [];
      for (var s2 = 0; s2 < sources.length; s2++) {
        list.push({
          url: sources[s2].url,
          quality: sources[s2].quality,
          container: sources[s2].type,
          headers: headers,
          subtitles: subtitles,
          kind: kind,
          introStart: introStart,
          introEnd: introEnd,
          outroStart: outroStart,
          outroEnd: outroEnd
        });
      }
      // Preflight: verify the master playlist answers with the exact
      // shipped headers (a 200 payload means nothing if segments 403).
      return _preflight(list[0].url, headers, providerId).then(function () {
        return list;
      });
    });
}

function _preflight(master, headers, providerId) {
  if (!master) return Promise.reject(new Error('AnimeX: empty stream url'));
  return fetch(master, { headers: headers, timeoutMs: 10000 }).then(function (r) { return r.text(); })
    .then(function (body) {
      var low = String(body || '').toLowerCase();
      if (low.indexOf('attention required') >= 0 || low.indexOf('just a moment') >= 0 ||
          low.indexOf('challenge-platform') >= 0 || low.indexOf('cf-error') >= 0) {
        throw new Error('AnimeX: ' + providerId + ' stream unreachable (cloudflare)');
      }
    }).catch(function (e) {
      throw new Error('AnimeX: ' + providerId + ' stream unreachable (' + ((e && e.message) || e) + ')');
    });
}
