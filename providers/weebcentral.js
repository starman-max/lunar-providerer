// WeebCentral — Lunar's own manga provider (weebcentral.com), ported from
// extensions/manga/weebcentral/manifest.json + lib/data/manga/manga_engine.dart.
// Interface (manga-shaped): search / getHome (popular) / getDetail /
// getChapters / getPages. Search+popular use /search/data HTML fragments;
// chapters via /series/{id}/full-chapter-list; pages via the chapter
// /images long-strip sub-URL (Referer, no Origin).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'weebcentral';

var SITE = 'https://weebcentral.com';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function getInfo() {
  return {
    name: 'WeebCentral',
    lang: 'en',
    baseUrl: SITE,
    type: 'manga',
    version: '1.0.1'
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

// article > section > a cards: title = last class-less div, falling back to
// the cover img alt text ("<Title> cover"); poster = img srcset first token
// (small -> normal), type = span.tooltip data-tip.
function _cards(html) {
  var out = [], seen = {};
  var re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, m;
  while ((m = re.exec(html)) !== null) {
    var href = m[1];
    if (seen[href]) continue;
    if (href.indexOf('/series/') < 0 && href.indexOf('/manga') < 0) continue;
    var inner = m[2];
    var divs = [];
    var dre = /<div([^>]*)>([\s\S]*?)<\/div>/gi, dm;
    while ((dm = dre.exec(inner)) !== null) {
      if (/class\s*=/.test(dm[1])) continue;
      var t = _text(dm[2]);
      if (t) divs.push(t);
    }
    var title = divs.length ? divs[divs.length - 1] : '';
    if (!title) {
      var altM = inner.match(/<img[^>]+alt="([^"]+)"/i);
      if (altM) title = _text(altM[1]).replace(/\s+cover\s*$/i, '');
    }
    if (!title) continue;
    seen[href] = 1;
    var img = inner.match(/<img[^>]+(?:srcset|src)="([^"\s]+)/i);
    var poster = img ? img[1].split(',')[0].trim().split(/\s+/)[0] : '';
    poster = poster ? _abs(poster.replace(/small/g, 'normal')) : null;
    var tip = (inner.match(/<span[^>]+class="[^"]*tooltip[^"]*"[^>]+data-tip="([^"]+)"/i) || [])[1] || '';
    out.push({
      id: href,
      title: title,
      url: _abs(href),
      cover: poster,
      type: tip || 'manga',
      sourceId: SOURCE_ID
    });
  }
  return out;
}

function search(query, page, opts) {
  var q = String(query || '').trim();
  if (!q) return Promise.resolve([]);
  var url = SITE + '/search/data?text=' + encodeURIComponent(q)
    + '&limit=32&offset=0&display_mode=Full%20Display';
  return _get(url).then(function (html) { return _cards(html); })
    .catch(function () { return []; });
}

function getHome(opts) {
  var url = SITE + '/search/data?text=&sort=Popularity&limit=32&offset=0&display_mode=Full%20Display';
  return _get(url)
    .then(function (html) {
      var cards = _cards(html);
      return [{ title: 'Popular', items: cards.slice(0, 32) }];
    })
    .catch(function () { return []; });
}

// <li> whose <strong> starts with the label -> inner <p> text.
function _labelText(html, label) {
  var re = /<li[^>]*>[\s\S]*?<strong[^>]*>\s*LABEL([\s\S]*?)<\/li>/gi;
  var lis = html.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
  for (var i = 0; i < lis.length; i++) {
    var strong = lis[i].match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
    if (!strong || _text(strong[1]).indexOf(label) !== 0) continue;
    var p = lis[i].match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (p) return _text(p[1]);
  }
  return '';
}

function getDetail(url, opts) {
  var full = url.indexOf('http') === 0 ? url : SITE + (url.charAt(0) === '/' ? url : '/' + url);
  return _get(full).then(function (html) {
    var h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
    var ogTitle = (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || [])[1] || '';
    var ogImage = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1] || null;
    var ogDesc = (html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i) || [])[1] || '';
    return getChapters(url, opts).then(function (chapters) {
      return {
        id: full,
        title: _text(h1 || ogTitle) || 'Unknown',
        cover: ogImage ? _abs(ogImage) : null,
        url: full,
        description: _labelText(html, 'Description') || _text(ogDesc),
        status: _labelText(html, 'Status'),
        type: 'manga',
        sourceId: SOURCE_ID,
        chapters: chapters,
        chapterCount: chapters.length
      };
    });
  });
}

function _seriesId(ref) {
  var path = String(ref || '');
  var hm = path.match(/^(https?:\/\/[^/]+)?(\/[^?#]*)/);
  if (hm) path = hm[2];
  var segs = path.split('/').filter(function (s) { return !!s; });
  for (var i = 0; i < segs.length; i++) {
    if (segs[i] === 'series' && i + 1 < segs.length) return segs[i + 1];
  }
  return String(ref || '');
}

// Dedicated list page: linkPattern alone decides (no series scoping).
function getChapters(seriesRef, opts) {
  var sid = _seriesId(seriesRef);
  return _get(SITE + '/series/' + sid + '/full-chapter-list').then(function (html) {
    var out = [], seen = {};
    var re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, m;
    while ((m = re.exec(html)) !== null) {
      var href = m[1];
      var path = (href.match(/^(https?:\/\/[^/]+)?(\/[^?#]*)/) || [])[2] || href;
      if (!/^\/chapters\/[A-Za-z0-9]+$/.test(path)) continue;
      if (seen[href]) continue;
      seen[href] = 1;
      var nm = m[2].match(/<span[^>]+class="[^"]*flex[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
      var name = _text(nm ? nm[1] : m[2]) || 'Chapter';
      var num = parseFloat((name.match(/(\d+(?:\.\d+)?)/) || [])[1] || '') ||
                parseFloat((path.match(/(\d+(?:\.\d+)?)/) || [])[1] || '') || 0;
      out.push({ id: href, number: num, title: name, url: _abs(href) });
    }
    out.sort(function (a, b) { return a.number - b.number; });
    return out;
  }).catch(function () { return []; });
}

// Chapter URL + /images?is_prev=False&reading_style=long_strip:
// imgs inside section[x-data*=scroll], extension-filtered.
function getPages(seriesRef, chapterRef, opts) {
  var curl = String(chapterRef || '');
  if (curl.indexOf('http') !== 0) curl = SITE + (curl.charAt(0) === '/' ? curl : '/' + curl);
  var url = curl + '/images?is_prev=False&reading_style=long_strip';
  return _get(url).then(function (html) {
    var out = [], seen = {};
    var secs = html.match(/<section[^>]+x-data[^>]*scroll[^>]*>([\s\S]*?)<\/section>/gi) || [html];
    for (var s = 0; s < secs.length; s++) {
      var re = /<img[^>]+src="([^"]+)"[^>]*>/gi, m;
      while ((m = re.exec(secs[s])) !== null) {
        var src = m[1];
        if (src.indexOf('//') === 0) src = 'https:' + src;
        else if (src.charAt(0) === '/') src = SITE + src;
        if (!/\.(png|jpg|jpeg|webp)/i.test(src)) continue;
        if (/logo|banner|avatar|icon|button/i.test(src)) continue;
        if (seen[src]) continue;
        seen[src] = 1;
        out.push({ index: out.length, url: src, headers: _headers() });
      }
    }
    if (!out.length) throw new Error('WeebCentral: no page images');
    return out;
  });
}
