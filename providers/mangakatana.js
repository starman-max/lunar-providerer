// MangaKatana — Lunar's own manga provider (mangakatana.com), ported from
// extensions/manga/mangakatana/manifest.json (engine: css) +
// lib/data/manga/manga_engine.dart.
// Classic scraper-friendly layout; chapter URLs are absolute
// (/manga/{slug}.{id}/c{N}); page images lazy-loaded (data-src) with
// obfuscated token-CDN arrays embedded in page JS.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'mangakatana';

var SITE = 'https://mangakatana.com';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function getInfo() {
  return {
    name: 'MangaKatana',
    lang: 'en',
    baseUrl: SITE,
    type: 'manga',
    version: '1.0.2'
  };
}

function _headers() {
  return { 'User-Agent': UA, 'Referer': SITE + '/' };
}

function _get(url) {
  return fetch(url, { headers: _headers() })
    .then(function (r) { return r.body || ''; });
}

function _text(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}

function _abs(href) {
  var h = String(href || '');
  if (/^https?:\/\//i.test(h)) return h;
  if (h.indexOf('//') === 0) return 'https:' + h;
  if (h.charAt(0) === '/') return SITE + h;
  return SITE + '/' + h;
}

function _meta(html, property) {
  var m = html.match(new RegExp('<meta[^>]+property="' + property + '"[^>]+content="([^"]+)"', 'i'));
  return m ? m[1] : '';
}

// One result per `div.item` block: the `h3.title` anchor carries the series
// URL + title; the cover anchor only holds alt="[Cover]". Chapter (/c<N>)
// and full-chapter (/fc) links share the /manga/ prefix but live outside
// h3.title, so they never become results.
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (!q) return Promise.resolve([]);
  return _get(SITE + '/?search=' + encodeURIComponent(q) + '&search_by=book_name')
    .then(function (html) {
      var out = [], seen = {};
      var items = html.split(/<div[^>]+class="[^"]*\bitem\b[^"]*"/i);
      for (var i = 1; i < items.length; i++) {
        var blk = items[i];
        var h3 = blk.match(/<h3[^>]+class="[^"]*title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]*\/manga\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!h3) continue;
        var href = h3[1];
        var path = (href.match(/^https?:\/\/[^/]+(\/[^?#]*)/) || [])[1] || href;
        if (/\/c[\d.]+$/.test(path) || /\/fc$/.test(path)) continue;
        if (seen[href]) continue;
        seen[href] = 1;
        var title = _text(h3[2]);
        if (!title) continue;
        var img = blk.match(/<img[^>]+(?:data-src|src)="([^"]+)"/i);
        out.push({
          id: href,
          title: title,
          url: _abs(href),
          cover: img ? _abs(img[1]) : null,
          type: 'manga',
          sourceId: SOURCE_ID
        });
      }
      return out;
    }).catch(function () { return []; });
}

function getHome(opts) {
  return Promise.resolve([]);
}

function _firstText(html, selectors) {
  for (var i = 0; i < selectors.length; i++) {
    var sel = selectors[i];
    if (sel.indexOf('og:') === 0) {
      var v = _meta(html, sel);
      if (v) return _text(v);
    } else {
      var cls = sel.replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var m = html.match(new RegExp('<div[^>]+class="[^"]*' + cls + '[^"]*"[^>]*>([\\s\\S]*?)<\\/div>', 'i'));
      if (m && _text(m[1])) return _text(m[1]);
    }
  }
  return '';
}

function getDetail(url, opts) {
  var full = url.indexOf('http') === 0 ? url : SITE + (url.charAt(0) === '/' ? url : '/' + url);
  return _get(full).then(function (html) {
    return getChapters(url, opts).then(function (chapters) {
      return {
        id: full,
        title: _text(_meta(html, 'og:title')) || 'Unknown',
        cover: _abs(_meta(html, 'og:image')) || null,
        url: full,
        description: _firstText(html, ['og:description', '.summary__content', '.description-summary', '.manga-description']),
        status: _firstText(html, ['.manga-status']),
        type: 'manga',
        sourceId: SOURCE_ID,
        chapters: chapters,
        chapterCount: chapters.length
      };
    });
  });
}

function _chapNum(text, path) {
  var m = String(text || '').match(/(\d+(?:\.\d+)?)/);
  if (m) return parseFloat(m[1]) || 0;
  var u = String(path || '').match(/(\d+(?:\.\d+)?)/);
  return u ? (parseFloat(u[1]) || 0) : 0;
}

// Links matching /manga/.+/c[\d.]+$, scoped under the series path.
function getChapters(seriesRef, opts) {
  var full = seriesRef.indexOf('http') === 0
    ? seriesRef
    : SITE + (seriesRef.charAt(0) === '/' ? seriesRef : '/' + seriesRef);
  var seriesPath = (full.match(/^https?:\/\/[^/]+(\/[^?#]*)/) || [])[1] || '';
  seriesPath = seriesPath.replace(/\/+$/, '');
  return _get(full).then(function (html) {
    var out = [], seen = {};
    var re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, m;
    while ((m = re.exec(html)) !== null) {
      var href = m[1];
      var f = href.indexOf('http') === 0 ? href : SITE + (href.charAt(0) === '/' ? href : '/' + href);
      var path = (f.match(/^https?:\/\/[^/]+(\/[^?#]*)/) || [])[1] || href;
      if (!/\/manga\/.+\/c[\d.]+$/.test(path)) continue;
      if (seriesPath && path.indexOf(seriesPath + '/') !== 0 && path !== seriesPath) continue;
      if (seen[f]) continue;
      seen[f] = 1;
      var title = _text(m[2]) || 'Chapter';
      out.push({ id: href, number: _chapNum(title, path), title: title, url: f });
    }
    out.sort(function (a, b) { return a.number - b.number; });
    return out;
  }).catch(function () { return []; });
}

// Strategy 0: token-CDN URLs embedded in page JS (rotating var names, so
// match the URL shape directly). Strategy 1: img data-src/src with the
// extension filter, chrome images excluded.
function getPages(seriesRef, chapterRef, opts) {
  var curl = String(chapterRef || '');
  if (curl.indexOf('http') !== 0) curl = SITE + (curl.charAt(0) === '/' ? curl : '/' + curl);
  return _get(curl).then(function (body) {
    var out = [], seen = {};
    function push(src) {
      if (!src || seen[src]) return;
      seen[src] = 1;
      out.push({ index: out.length, url: src, headers: _headers() });
    }
    var jm = body.match(/https:\/\/i\d?\.mangakatana\.com\/token\/[^'"\s]+\.(jpg|jpeg|png|webp)/gi) || [];
    for (var j = 0; j < jm.length; j++) push(jm[j]);
    if (out.length) return out;
    var re = /<img[^>]*>/gi, m;
    while ((m = re.exec(body)) !== null) {
      var tag = m[0];
      var src = (tag.match(/data-src="([^"]+)"/i) || [])[1]
        || (tag.match(/src="([^"]+)"/i) || [])[1] || '';
      if (!src) continue;
      if (src.indexOf('//') === 0) src = 'https:' + src;
      else if (src.charAt(0) === '/') src = SITE + src;
      else if (!/^https?:\/\//i.test(src)) src = SITE + '/' + src;
      if (!/\.(jpg|jpeg|png|webp|avif)/i.test(src)) continue;
      if (/logo|banner|avatar|icon|button/i.test(src)) continue;
      push(src);
    }
    if (!out.length) throw new Error('MangaKatana: no page images');
    return out;
  });
}
