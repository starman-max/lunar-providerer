// YLnime — Indonesian anime provider for Zangetsu (ylnime.com).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'ylnime';

var SITE = 'https://ylnime.com';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function getInfo() {
  return {
    name: 'YLnime',
    lang: 'id',
    baseUrl: SITE,
    logo: SITE + '/favicon-96x96.png',
    type: 'anime',
    version: '1.0.0'
  };
}

function _get(url, ref) {
  var h = { 'User-Agent': UA, 'Referer': ref || SITE + '/index.php' };
  return fetch(url, { headers: h })
    .then(function (r) { return r.body || ''; })
    .catch(function () { return ''; });
}

function _cleanTitle(t) {
  return String(t || '')
    .replace(/\s*(Subtitle Indonesia|Sub Indo)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _ensureAbsolute(u) {
  if (!u) return '';
  if (u.indexOf('http://') === 0 || u.indexOf('https://') === 0) return u;
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.indexOf('/') === 0) return SITE + u;
  if (u.indexOf('?') === 0) return SITE + '/index.php' + u;
  return SITE + '/' + u;
}

function _parseCards(html) {
  var out = [], seen = {};
  var cardBlocks = html.match(/<div class="[^"]*col[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi) || [];
  for (var i = 0; i < cardBlocks.length; i++) {
    var block = cardBlocks[i];
    var linkMatch = block.match(/href="([^"]*series=[^"]+)"/i);
    if (!linkMatch) continue;
    var rawUrl = linkMatch[1];
    var fullUrl = _ensureAbsolute(rawUrl);
    if (seen[fullUrl]) continue;
    seen[fullUrl] = 1;

    var titleMatch = block.match(/<h6[^>]*class="[^"]*card-title[^"]*"[^>]*>([^<]+)<\/h6>/i)
      || block.match(/alt="([^"]+)"/i);
    var title = _cleanTitle(htmlText(titleMatch ? titleMatch[1] : ''));
    if (!title || title.toLowerCase() === 'advertisement' || title.toLowerCase() === 'cover') continue;

    var imgMatch = block.match(/<img[^>]+src="([^"]+)"[^>]*class="[^"]*card-img-top[^"]*"/i)
      || block.match(/<img[^>]+src="([^"]+)"/i);
    var cover = imgMatch ? _ensureAbsolute(imgMatch[1]) : null;

    out.push({
      id: fullUrl,
      title: title,
      url: fullUrl,
      cover: cover,
      type: 'anime',
      sourceId: SOURCE_ID
    });
  }
  return out;
}

// ── Search ───────────────────────────────────────────────────────────────────
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1) return Promise.resolve([]);
  var url = SITE + '/index.php?search=' + encodeURIComponent(q);
  return _get(url, SITE + '/index.php').then(function (html) {
    return _parseCards(html);
  }).catch(function () { return []; });
}

// ── Home ─────────────────────────────────────────────────────────────────────
function getHome(opts) {
  var sections = [
    { title: 'Terbaru', url: SITE + '/index.php?terbaru=1' },
    { title: 'Ongoing Anime', url: SITE + '/ongoing.php' },
    { title: 'Completed Anime', url: SITE + '/completed.php' },
    { title: 'Anime Movies', url: SITE + '/movies.php' }
  ];

  var tasks = sections.map(function (sec) {
    return _get(sec.url, SITE + '/index.php').then(function (html) {
      var cards = _parseCards(html);
      return { title: sec.title, items: cards.slice(0, 24) };
    }).catch(function () {
      return { title: sec.title, items: [] };
    });
  });

  return Promise.all(tasks).then(function (res) {
    var valid = [];
    for (var i = 0; i < res.length; i++) {
      if (res[i].items && res[i].items.length > 0) valid.push(res[i]);
    }
    return valid;
  });
}

// ── Detail & Episodes ────────────────────────────────────────────────────────
function getDetail(url, opts) {
  var fullUrl = _ensureAbsolute(url);
  return _get(fullUrl, SITE + '/index.php').then(function (html) {
    var title = _cleanTitle(
      (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]
      || (html.match(/<title>([^<]+)<\/title>/i) || [])[1]
      || (fullUrl.match(/series=([^&]+)/) || [])[1]
      || 'Untitled'
    );

    var posterMatch = html.match(/<img[^>]+class="[^"]*img-fluid rounded[^"]*"[^>]+src="([^"]+)"/i)
      || html.match(/<img[^>]+src="([^"]+)"[^>]+class="[^"]*img-fluid rounded[^"]*"/i)
      || html.match(/<img[^>]+src="([^"]+)"[^>]+class="[^"]*card-img-top[^"]*"/i);
    var poster = posterMatch ? _ensureAbsolute(posterMatch[1]) : null;

    var synMatch = html.match(/<p class="text-light[^"]*"[\s\S]*?>([\s\S]*?)<\/p>/i);
    var synopsis = synMatch ? htmlText(synMatch[1]) : '';

    var episodes = [];
    var epTags = html.match(/<a[^>]+href="[^"]*episode=[^"]+"[^>]*>([\s\S]*?)<\/a>/gi) || [];
    var seenEp = {};
    for (var i = 0; i < epTags.length; i++) {
      var tag = epTags[i];
      var hrefMatch = tag.match(/href="([^"]+)"/i);
      if (!hrefMatch) continue;
      var epUrl = _ensureAbsolute(hrefMatch[1]);
      if (seenEp[epUrl]) continue;
      seenEp[epUrl] = 1;

      var labelMatch = tag.match(/<span[^>]*class="[^"]*fw-medium[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
        || tag.match(/Episode\s+(\d+)/i)
        || [null, 'Episode ' + (episodes.length + 1)];
      var epLabel = _cleanTitle(htmlText(labelMatch[1] || labelMatch[0]));

      var dateMatch = tag.match(/<small class="text-muted">([^<]+)<\/small>/i);
      var epDate = dateMatch ? htmlText(dateMatch[1]) : null;

      var numMatch = epLabel.match(/Episode\s+(\d+)/i) || epLabel.match(/(\d+)/);
      var num = numMatch ? parseInt(numMatch[1], 10) : (episodes.length + 1);

      episodes.push({
        id: epUrl,
        number: num,
        title: epLabel,
        url: epUrl,
        date: epDate
      });
    }

    episodes.sort(function (a, b) { return a.number - b.number; });

    return {
      id: fullUrl,
      title: title,
      englishTitle: null,
      cover: poster,
      url: fullUrl,
      description: synopsis,
      status: 'unknown',
      genres: [],
      studios: [],
      type: 'anime',
      sourceId: SOURCE_ID,
      episodes: episodes,
      subCount: episodes.length,
      dubCount: 0
    };
  });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) { return d.episodes; });
}

// ── Stream Extraction ────────────────────────────────────────────────────────
function getVideoSources(episodeUrl) {
  var fullUrl = _ensureAbsolute(episodeUrl);
  return _get(fullUrl, SITE + '/index.php').then(function (html) {
    if (!html) return Promise.reject(new Error('YLnime: episode page not found'));

    var streamsMatch = html.match(/const\s+streams\s*=\s*(\[[^\]]+\]);/i)
      || html.match(/streams\s*=\s*(\[[^\]]+\]);/i)
      || html.match(/(\[\s*\{[\s\S]*?"link"[\s\S]*?\}\s*\])/i);

    if (!streamsMatch) return Promise.reject(new Error('YLnime: no stream found on episode page'));

    var rawList = [];
    try {
      rawList = JSON.parse(streamsMatch[1]);
    } catch (e) {
      return Promise.reject(new Error('YLnime: failed to parse stream list'));
    }

    var sources = [];
    var seen = {};
    for (var i = 0; i < rawList.length; i++) {
      var s = rawList[i];
      if (!s || !s.link) continue;
      var streamUrl = s.link.replace(/\\/g, '');
      if (seen[streamUrl]) continue;
      seen[streamUrl] = 1;

      var isHls = /\.m3u8(\?|$)/i.test(streamUrl);
      var q = s.reso || '720p';

      sources.push({
        url: streamUrl,
        quality: q,
        container: isHls ? 'hls' : 'mp4',
        headers: {
          'User-Agent': UA,
          'Referer': SITE + '/'
        },
        kind: 'sub',
        audioLang: 'ja'
      });
    }

    if (!sources.length) return Promise.reject(new Error('YLnime: no playable streams found'));

    sources.sort(function (a, b) {
      var aVal = (a.container === 'hls' ? 10 : 0) + (parseInt(a.quality, 10) || 0);
      var bVal = (b.container === 'hls' ? 10 : 0) + (parseInt(b.quality, 10) || 0);
      return bVal - aVal;
    });

    return sources;
  });
}
