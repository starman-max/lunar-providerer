// AnimeGG — Lunar's own anime provider (animegg.org), ported from
// lib/data/extension_engine/scrapers/scraper_impls.dart (AnimeGgScraper).
// Search/series/episode pages are HTML (regex-parsed, no DOM needed);
// episode embeds carry {file:"...",label:"..."} MP4 sources.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'animegg';

var SITE = 'https://www.animegg.org';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function getInfo() {
  return {
    name: 'AnimeGG',
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

function _abs(href) {
  var h = String(href || '');
  if (/^https?:\/\//i.test(h)) return h;
  if (h.indexOf('//') === 0) return 'https:' + h;
  if (h.charAt(0) === '/') return SITE + h;
  return SITE + '/' + h;
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

// div.moose a.mse cards: /series/<slug>, h2 title, img.media-object poster.
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (!q) return Promise.resolve([]);
  return _get(SITE + '/search/?q=' + encodeURIComponent(q)).then(function (html) {
    var out = [], seen = {};
    var cards = html.match(/<div[^>]+class="[^"]*moose[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi) || [];
    for (var i = 0; i < cards.length; i++) {
      var a = cards[i].match(/<a[^>]+class="[^"]*\bmse\b[^"]*"[^>]*>/i)
        || cards[i].match(/<a[^>]*>/i);
      if (!a) continue;
      var href = (a[0].match(/href="([^"]+)"/i) || [])[1] || '';
      if (href.indexOf('/series/') !== 0 || seen[href]) continue;
      seen[href] = 1;
      var h2 = cards[i].match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      var title = h2 ? _text(h2[1]) : '';
      if (!title) {
        var ta = a[0].match(/title="([^"]+)"/i);
        title = ta ? _text(ta[1]) : href.split('/').pop().replace(/-/g, ' ');
      }
      var img = cards[i].match(/<img[^>]+class="[^"]*media-object[^"]*"[^>]*>/i)
        || cards[i].match(/<img[^>]*>/i);
      var poster = '';
      if (img) {
        var src = (img[0].match(/src="([^"]+)"/i) || [])[1] || '';
        poster = src ? _abs(src) : '';
      }
      out.push({
        id: href.split('/').pop(),
        title: title,
        url: href,
        cover: poster,
        type: 'anime',
        sourceId: SOURCE_ID
      });
    }
    return out;
  }).catch(function () { return []; });
}

function getDetail(url, opts) {
  var full = url.indexOf('http') === 0 ? url : SITE + (url.charAt(0) === '/' ? url : '/' + url);
  return _get(full).then(function (html) {
    var title = ((html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || [])[1])
      || ((html.match(/<title>([^<]+)<\/title>/i) || [])[1])
      || 'Unknown';
    var poster = ((html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1]) || null;
    return getEpisodes(url, opts).then(function (eps) {
      return {
        id: full,
        title: _text(title),
        cover: poster ? _abs(poster) : null,
        url: full,
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

// Every `*-episode-<n>` link, first hit per number wins.
function getEpisodes(url, opts) {
  var full = url.indexOf('http') === 0 ? url : SITE + (url.charAt(0) === '/' ? url : '/' + url);
  return _get(full).then(function (html) {
    var byNum = {}, order = [];
    var re = /<a[^>]+href="([^"]*-episode-(\d+)[^"]*)"[^>]*>/gi, m;
    while ((m = re.exec(html)) !== null) {
      var href = m[1].split('#')[0];
      var num = parseInt(m[2], 10);
      if (!href || !num || byNum[num]) continue;
      byNum[num] = 1;
      order.push({ id: href, number: num, title: 'Episode ' + num, url: href });
    }
    order.sort(function (a, b) { return a.number - b.number; });
    return order;
  }).catch(function () { return []; });
}

// Sub/dub live in separate tab panes (div#subbed-*/dubbed-* > iframe);
// fallback: any /embed/ iframe. The embed page carries {file,label} MP4s.
function getVideoSources(episodeUrl, opts) {
  var isDub = !!(opts && opts.dub);
  var url = episodeUrl.indexOf('http') === 0 ? episodeUrl : SITE + episodeUrl;
  return _get(url).then(function (html) {
    var paneRe = isDub
      ? /<div[^>]+id="dubbed-[^"]*"[\s\S]*?<iframe[^>]+src="([^"]+)"[^>]*>/i
      : /<div[^>]+id="subbed-[^"]*"[\s\S]*?<iframe[^>]+src="([^"]+)"[^>]*>/i;
    var embed = ((html.match(paneRe) || [])[1]) || '';
    if (!embed) {
      var frames = [];
      var fre = /<iframe[^>]+src="([^"]*\/embed\/[^"]*)"[^>]*>/gi, fm;
      while ((fm = fre.exec(html)) !== null) frames.push(fm[1]);
      if (frames.length) embed = (isDub && frames.length > 1) ? frames[1] : frames[0];
    }
    if (!embed) throw new Error('AnimeGG: no player embed');
    var embedUrl = _abs(embed);
    return _get(embedUrl, url);
  }).then(function (body) {
    var sources = [], seen = {};
    var re = /\{file:\s*"([^"]+)"\s*,\s*label:\s*"([^"]+)"/g, m;
    while ((m = re.exec(body)) !== null) {
      var file = m[1];
      if (file.charAt(0) === '/') file = SITE + file;
      if (seen[file]) continue;
      seen[file] = 1;
      sources.push({ quality: m[2], url: file, container: 'mp4' });
    }
    if (!sources.length) throw new Error('AnimeGG: no video sources');
    return {
      sources: sources,
      headers: { 'User-Agent': UA, 'Referer': SITE },
      subtitles: []
    };
  });
}
