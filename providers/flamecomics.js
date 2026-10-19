// FlameComics — Lunar's own manga provider (flamecomics.xyz), ported from
// extensions/manga/flamecomics/manifest.json (engine: nextdata) +
// lib/data/manga/manga_engine.dart.
// Next.js __NEXT_DATA__ JSON drives everything; there is no server-side
// search, so search() filters the /browse catalog client-side by title.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'flamecomics';

var SITE = 'https://flamecomics.xyz';
var CDN = 'https://cdn.flamecomics.xyz';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function getInfo() {
  return {
    name: 'FlameComics',
    lang: 'en',
    baseUrl: SITE,
    type: 'manga',
    version: '1.0.0'
  };
}

function _headers() {
  return { 'User-Agent': UA, 'Referer': SITE + '/' };
}

function _get(url) {
  return fetch(url, { headers: _headers() })
    .then(function (r) { return r.body || ''; });
}

function _nextdata(html) {
  var m = String(html || '').match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('FlameComics: no NEXT_DATA on page');
  return JSON.parse(m[1]);
}

// Dotted paths with single-level `*` flattening:
// "props.pageProps.popularEntries.blocks.*.series".
function _walkList(root, path) {
  var current = [root];
  var segs = String(path || '').split('.');
  for (var s = 0; s < segs.length; s++) {
    var next = [];
    for (var n = 0; n < current.length; n++) {
      var node = current[n];
      if (segs[s] === '*') {
        if (node instanceof Array) {
          for (var k = 0; k < node.length; k++) next.push(node[k]);
        }
      } else if (node && typeof node === 'object' && segs[s] in node) {
        next.push(node[segs[s]]);
      }
    }
    current = next;
  }
  var flat = [];
  for (var f = 0; f < current.length; f++) {
    if (current[f] instanceof Array) {
      for (var g = 0; g < current[f].length; g++) flat.push(current[f][g]);
    } else if (current[f] != null) {
      flat.push(current[f]);
    }
  }
  return flat;
}

function _walkOne(root, path) {
  var node = root;
  var segs = String(path || '').split('.');
  for (var s = 0; s < segs.length; s++) {
    if (node && typeof node === 'object' && segs[s] in node) node = node[segs[s]];
    else return null;
  }
  return node;
}

function _thumb(seriesId) {
  return CDN + '/uploads/images/series/' + seriesId + '/thumbnail.webp';
}

function _mapItem(m) {
  if (!m || typeof m !== 'object') return null;
  var id = String(m.series_id || m.id || '');
  if (!id) return null;
  var cover = String(m.thumb || m.cover || '');
  if (!cover) cover = _thumb(id);
  else if (cover.indexOf('cdn:') === 0) cover = cover.replace('cdn:', CDN + '/');
  return {
    id: id,
    title: String(m.title || 'Unknown'),
    url: id,
    cover: cover,
    type: String(m.type || 'manga'),
    sourceId: SOURCE_ID
  };
}

function _isAdult(title, type) {
  var t = (String(title || '') + ' ' + String(type || '')).toLowerCase();
  return t.indexOf('adult') >= 0;
}

function _browse() {
  return _get(SITE + '/browse').then(function (html) {
    var items = _walkList(_nextdata(html), 'props.pageProps.series');
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var r = _mapItem(items[i]);
      if (r && !_isAdult(r.title, r.type)) out.push(r);
    }
    return out;
  });
}

function search(query, page, opts) {
  var q = String(query || '').trim().toLowerCase();
  if (!q) return Promise.resolve([]);
  return _browse().then(function (items) {
    var words = q.split(/\s+/);
    return items.filter(function (it) {
      var t = String(it.title || '').toLowerCase();
      for (var w = 0; w < words.length; w++) {
        if (t.indexOf(words[w]) < 0) return false;
      }
      return true;
    });
  }).catch(function () { return []; });
}

function getHome(opts) {
  return _get(SITE + '/').then(function (html) {
    var items = _walkList(_nextdata(html), 'props.pageProps.popularEntries.blocks.*.series');
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var r = _mapItem(items[i]);
      if (r && !_isAdult(r.title, r.type)) out.push(r);
    }
    return [{ title: 'Popular', items: out.slice(0, 32) }];
  }).catch(function () { return []; });
}

function getDetail(url, opts) {
  var id = String(url || '').split('/').filter(function (s) { return !!s; }).pop();
  return _get(SITE + '/series/' + id).then(function (html) {
    var root = _walkOne(_nextdata(html), 'props.pageProps');
    if (!root || typeof root !== 'object') throw new Error('FlameComics: bad detail payload');
    var series = root.series || {};
    return getChapters(id, opts).then(function (chapters) {
      return {
        id: id,
        title: String(series.title || 'Unknown'),
        cover: _thumb(id),
        url: SITE + '/series/' + id,
        description: String(series.description || '').replace(/<[^>]*>/g, ' '),
        status: '',
        type: 'manga',
        sourceId: SOURCE_ID,
        chapters: chapters,
        chapterCount: chapters.length
      };
    });
  });
}

function getChapters(seriesRef, opts) {
  var id = String(seriesRef || '').split('/').filter(function (s) { return !!s; }).pop();
  return _get(SITE + '/series/' + id).then(function (html) {
    var root = _walkOne(_nextdata(html), 'props.pageProps');
    if (!root || typeof root !== 'object') throw new Error('FlameComics: bad detail payload');
    var list = root.chapters || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || typeof e !== 'object') continue;
      var token = String(e.token || '');
      var num = parseFloat(e.chapter) || 0;
      if (!token) continue;
      out.push({
        id: token,
        number: num,
        title: 'Chapter ' + (e.chapter || num),
        url: '/series/' + id + '/' + token
      });
    }
    out.sort(function (a, b) { return a.number - b.number; });
    return out;
  }).catch(function () { return []; });
}

function getPages(seriesRef, chapterRef, opts) {
  var sid = String(seriesRef || '').split('/').filter(function (s) { return !!s; }).pop();
  var token = String(chapterRef || '').split('/').filter(function (s) { return !!s; }).pop();
  return _get(SITE + '/series/' + sid + '/' + token).then(function (html) {
    var images = _walkOne(_nextdata(html), 'props.pageProps.chapter.images');
    if (!images || typeof images !== 'object') throw new Error('FlameComics: no page images');
    var keys = [];
    for (var k in images) keys.push(k);
    keys.sort(function (a, b) { return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0); });
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var entry = images[keys[i]] || {};
      var name = String(entry.name || '');
      if (!name) continue;
      out.push({
        index: out.length,
        url: CDN + '/uploads/images/series/' + sid + '/' + token + '/' + name,
        headers: _headers()
      });
    }
    if (!out.length) throw new Error('FlameComics: no page images');
    return out;
  });
}
