// Otakudesu — Ultra-Fast Indonesian Anime Provider for Zangetsu (otakudesu.blog)

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'otakudesu';

var SITE = 'https://otakudesu.blog';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Servers that cannot be extracted (download-only, dead, or require captcha)
// Note: moedesu/moedesuhd are NOT skipped as they serve direct googlevideo mp4 streams
var SKIP_SERVERS = /\b(mega|filedon|kraken|krakenfiles|nekoclouds|zippyshare|acefile|racaty|gdrive2?|solidfiles|filesim|hxfile|shareweb)\b/i;
// Embed domains that we cannot extract direct streams from
var SKIP_EMBEDS = /blogger\.com|filedon\.co|mega\.nz|krakenfiles\.com|nekoclouds\.com|solidfiles\.com/i;

function getInfo() {
  return {
    name: 'Otakudesu',
    lang: 'id',
    baseUrl: SITE,
    logo: SITE + '/wp-content/uploads/2017/06/Logo-1.png',
    type: 'anime',
    version: '2.0.3'
  };
}

function _get(url, ref, timeoutMs) {
  var h = { 'User-Agent': UA, 'Referer': ref || SITE + '/' };
  return fetch(url, { headers: h, timeoutMs: timeoutMs || 8000 })
    .then(function (r) { return r.body || ''; })
    .catch(function () { return ''; });
}

function _post(url, data, ref, timeoutMs) {
  var h = {
    'User-Agent': UA,
    'Referer': ref || SITE + '/',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest'
  };
  var body = '';
  if (typeof data === 'string') {
    body = data;
  } else if (data && typeof data === 'object') {
    var pairs = [];
    for (var k in data) {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(data[k]));
      }
    }
    body = pairs.join('&');
  }
  return fetch(url, { method: 'POST', headers: h, body: body, timeoutMs: timeoutMs || 8000 })
    .then(function (r) {
      var j;
      try { j = JSON.parse(r.body || 'null'); } catch (e) { j = null; }
      return j;
    })
    .catch(function () { return null; });
}

function _cleanTitle(t) {
  return String(t || '')
    .replace(/\s*(Subtitle Indonesia|Sub Indo)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _b64Decode(b64) {
  if (typeof atob === 'function') return atob(b64);
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  var str = String(b64).replace(/[=]+$/, '');
  var out = '';
  for (var bc = 0, bs = 0, buffer, i = 0; (buffer = str.charAt(i++)); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? out += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
    buffer = chars.indexOf(buffer);
  }
  return out;
}

function _unpack(code) {
  try {
    var match = code.match(/eval\s*\(\s*function\s*\([^\)]*\)\s*\{[\s\S]*?\}\s*\(\s*['"]([^]*?)['"](?:\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([^]*?)['"]\s*\.split\()/i)
      || code.match(/}\s*\(\s*['"]([^]*?)['"](?:\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([^]*?)['"]\s*\.split\()/i);
    if (!match) return '';
    var payload = match[1];
    var radix = parseInt(match[2], 10);
    var count = parseInt(match[3], 10);
    var symtab = match[4].split('|');

    var encode = function (c) {
      return (c < radix ? '' : encode(Math.floor(c / radix))) +
        ((c = c % radix) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
    };

    for (var i = count; i--; ) {
      if (symtab[i]) {
        payload = payload.replace(new RegExp('\\b' + encode(i) + '\\b', 'g'), symtab[i]);
      }
    }
    return payload;
  } catch (e) {
    return '';
  }
}

// ── Search ───────────────────────────────────────────────────────────────────
function search(query, page, opts) {
  var q = String(query || '').trim();
  if (q.length < 1) return Promise.resolve([]);
  var url = SITE + '/?s=' + encodeURIComponent(q) + '&post_type=anime';
  return _get(url, SITE + '/', 3000).then(function (html) {
    var out = [], seen = {};
    var chunks = html.split('<ul class="chivsrc">');
    if (chunks.length < 2) return [];
    var listBlock = chunks[1].split('</ul>')[0];
    var items = listBlock.split('<li');
    for (var i = 1; i < items.length; i++) {
      var c = items[i];
      var linkMatch = c.match(/<h2[^>]*><a\s+href="([^"]+)"[^>]*>([^<]+)<\/a><\/h2>/i)
        || c.match(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
      if (!linkMatch) continue;
      var aurl = linkMatch[1];
      if (seen[aurl]) continue;
      seen[aurl] = 1;
      var title = _cleanTitle(htmlText(linkMatch[2]));
      var img = (c.match(/<img[^>]+src="([^"]+)"/) || [])[1] || null;
      out.push({
        id: aurl,
        title: title,
        url: aurl,
        cover: img,
        type: 'anime',
        sourceId: SOURCE_ID
      });
    }
    return out;
  }).catch(function () { return []; });
}

// ── Home ─────────────────────────────────────────────────────────────────────
function getHome(opts) {
  return _get(SITE + '/', SITE + '/', 3000).then(function (html) {
    var sections = html.split(/<div class=["']venz["']>/i);
    var out = [];
    for (var i = 1; i < sections.length; i++) {
      var sec = sections[i];
      var secTitle = (i === 1) ? 'On-going Anime' : 'Complete Anime';
      var items = sec.split(/<div class=["']detpost["']>/i);
      var cards = [], seen = {};
      for (var j = 1; j < items.length; j++) {
        var it = items[j];
        var linkMatch = it.match(/<div class="thumb"><a\s+href="([^"]+)"/i)
          || it.match(/<a\s+href="([^"]+)"/i);
        if (!linkMatch) continue;
        var aurl = linkMatch[1];
        if (seen[aurl]) continue;
        seen[aurl] = 1;
        var titleMatch = it.match(/<h2 class="jdlflm">([^<]+)<\/h2>/i)
          || it.match(/<a[^>]+title="([^"]+)"/i);
        var title = _cleanTitle(htmlText(titleMatch ? titleMatch[1] : ''));
        var img = (it.match(/<img[^>]+src="([^"]+)"/) || [])[1] || null;
        if (!title) continue;
        cards.push({
          id: aurl,
          title: title,
          url: aurl,
          cover: img,
          type: 'anime',
          sourceId: SOURCE_ID
        });
      }
      if (cards.length) {
        out.push({ title: secTitle, items: cards });
      }
    }
    return out;
  }).catch(function () { return []; });
}

// ── Detail & Episodes ────────────────────────────────────────────────────────
function getDetail(url, opts) {
  var aurl = String(url);
  return _get(aurl, SITE + '/', 3000).then(function (html) {
    var title = _cleanTitle(
      (html.match(/<b>Judul<\/b>\s*:\s*([^<]+)/i) || [])[1]
      || (html.match(/<div class="infozingle">[\s\S]*?<b>Judul<\/b>\s*:\s*([^<]+)/i) || [])[1]
      || (html.match(/<h1 class="jdlz">([^<]+)<\/h1>/i) || [])[1]
      || (html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || [])[1]
      || (aurl.match(/\/anime\/([^/]+)/) || [])[1]
      || ''
    );
    var japanese = htmlText((html.match(/<b>Japanese<\/b>\s*:\s*([^<]+)/i) || [])[1] || '');
    var poster = (html.match(/<img[^>]+class="attachment-post-thumbnail[^"]*"[^>]+src="([^"]+)"/i)
      || html.match(/<div class="fotoanime"><img[^>]+src="([^"]+)"/i) || [])[1] || null;
    var synopsis = htmlText((html.match(/<div class="sinopc">([\s\S]*?)<\/div>/i) || [])[1] || '');
    var statusRaw = htmlText((html.match(/<b>Status<\/b>\s*:\s*([^<]+)/i) || [])[1] || '').toLowerCase();
    var status = statusRaw.indexOf('ongoing') > -1 ? 'ongoing'
      : (statusRaw.indexOf('complete') > -1 ? 'completed' : 'unknown');

    var genres = [];
    var genreBlock = (html.match(/<b>Genres?<\/b>\s*:\s*([\s\S]*?)<\/p>/i) || [])[1] || '';
    var gMatch = genreBlock.match(/<a[^>]*>([^<]+)<\/a>/g) || [];
    for (var g = 0; g < gMatch.length; g++) {
      var gt = htmlText(gMatch[g]);
      if (gt) genres.push(gt);
    }

    var episodes = [];
    var epLists = html.split('<div class="episodelist">');
    for (var i = 1; i < epLists.length; i++) {
      var block = epLists[i].split('</ul>')[0];
      var liItems = block.split('<li>');
      for (var j = 1; j < liItems.length; j++) {
        var item = liItems[j];
        var linkMatch = item.match(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
        if (!linkMatch) continue;
        var epUrl = linkMatch[1];
        if (epUrl.indexOf('/episode/') === -1 || epUrl.indexOf('pembatas-episode') > -1) continue;
        var rawEpTitle = htmlText(linkMatch[2]);
        var epDate = htmlText((item.match(/<span class="zeebr"[^>]*>([^<]+)<\/span>/i) || [])[1] || '');
        var numMatch = rawEpTitle.match(/Episode\s+(\d+)/i) || rawEpTitle.match(/(\d+)/);
        var num = numMatch ? parseInt(numMatch[1], 10) : (episodes.length + 1);
        episodes.push({
          id: epUrl,
          number: num,
          title: _cleanTitle(rawEpTitle),
          url: epUrl,
          date: epDate || null
        });
      }
    }

    episodes.sort(function (a, b) { return a.number - b.number; });

    return {
      id: aurl,
      title: title || 'Untitled',
      englishTitle: japanese || null,
      cover: poster,
      url: aurl,
      description: synopsis,
      status: status,
      genres: genres,
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
function _extractFromEmbed(embedUrl, ref, timeoutMs, depth) {
  if (!embedUrl) return Promise.resolve([]);
  if (SKIP_EMBEDS.test(embedUrl)) return Promise.resolve([]);
  return _get(embedUrl, ref || SITE + '/', timeoutMs || 1800).then(function (html) {
    if (!html) return [];
    var out = [];

    var addStream = function (sUrl, q) {
      if (!sUrl) return;
      sUrl = sUrl.replace(/\\/g, '').replace(/&amp;/g, '&').trim();
      if (sUrl.indexOf('http') !== 0 || sUrl.indexOf('novideo') > -1) return;
      var isHls = /\.m3u8(\?|$)/i.test(sUrl) || /\/hls[23]?\//i.test(sUrl);
      var isGvideo = /googlevideo\.com/i.test(sUrl);
      var isArchive = /archive\.org/i.test(sUrl);

      // Clean headers so mobile ExoPlayer/AVPlayer do not receive 403 Forbidden
      var streamHeaders = { 'User-Agent': UA };
      if (isGvideo) {
        streamHeaders['Referer'] = 'https://www.blogger.com/';
      } else if (!isArchive) {
        streamHeaders['Referer'] = embedUrl;
      }

      out.push({
        url: sUrl,
        quality: q || 'default',
        container: isHls ? 'hls' : 'mp4',
        headers: streamHeaders,
        kind: 'sub',
        audioLang: 'ja'
      });
    };

    // 1. Direct video source or file URL
    var fileMatch = html.match(/const\s+videoURL\s*=\s*["']([^"']+)["']/i)
      || html.match(/videoURL\s*=\s*["']([^"']+)["']/i)
      || html.match(/<source[^>]+src=["']([^"']+)["']/i)
      || html.match(/file\s*:\s*["'](https?:[^"']+\.(?:mp4|m3u8)[^"']*)["']/i)
      || html.match(/src\s*:\s*["'](https?:[^"']+\.(?:mp4|m3u8)[^"']*)["']/i)
      || html.match(/player\.src\(\s*\{[^}]*src:\s*["']([^"']+)["']/i)
      || html.match(/property=["']og:video["']\s+content=["']([^"']+)["']/i)
      || html.match(/<video[^>]+src=["']([^"']+)["']/i);

    if (fileMatch && fileMatch[1]) {
      addStream(fileMatch[1]);
      return out;
    }

    // 2. Packed JS evaluation (VidHide, StreamWish, etc.)
    if (html.indexOf('eval(') > -1) {
      var unpacked = _unpack(html);
      if (unpacked) {
        var m3u8Match = unpacked.match(/https?:\/\/[^"'\s`\\]+\.m3u8[^"'\s`\\]*/i)
          || unpacked.match(/https?:\/\/[^"'\s`\\]+\/hls[23]?\/[^"'\s`\\]*/i)
          || unpacked.match(/file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
        if (m3u8Match) {
          addStream(m3u8Match[1] || m3u8Match[0]);
          return out;
        }
      }
    }

    // 3. Nested iframe (e.g. desudrive wrapping yourupload)
    if (!depth || depth < 2) {
      var nestedIfr = (html.match(/<iframe[^>]+src=["']([^"']+)["']/i) || [])[1];
      if (nestedIfr && nestedIfr !== embedUrl && !SKIP_EMBEDS.test(nestedIfr)) {
        return _extractFromEmbed(nestedIfr, embedUrl, timeoutMs, (depth || 0) + 1);
      }
    }

    return out;
  }).catch(function () { return []; });
}

// Quality sort priority: higher resolution first
function _qualityScore(q) {
  if (!q) return 0;
  var n = parseInt(q, 10);
  if (n >= 1080) return 4;
  if (n >= 720) return 3;
  if (n >= 480) return 2;
  if (n >= 360) return 1;
  return 0;
}

function _resolveAllMirrors(epHtml, episodeUrl) {
  var nonceActions = epHtml.match(/action:\s*"([a-f0-9]{32})"/g) || [];
  if (nonceActions.length < 2) return Promise.resolve([]);

  var streamAction = (nonceActions[0].match(/"([a-f0-9]{32})"/) || [])[1];
  var nonceAction = (nonceActions[1].match(/"([a-f0-9]{32})"/) || [])[1];

  return _post(SITE + '/wp-admin/admin-ajax.php', { action: nonceAction }, episodeUrl, 1500)
    .then(function (nonceRes) {
      var nonce = nonceRes && nonceRes.data;
      if (!nonce) return [];

      // Parse ALL mirror links from the episode page
      var mirrorLinks = epHtml.match(/<a[^>]+data-content="([^"]+)"[^>]*>[^<]+<\/a>/g) || [];
      var candidates = [];

      for (var m = 0; m < mirrorLinks.length; m++) {
        var linkTag = mirrorLinks[m];
        var contentB64 = (linkTag.match(/data-content="([^"]+)"/) || [])[1];
        if (!contentB64) continue;
        var decoded = _b64Decode(contentB64);
        var parsed;
        try { parsed = JSON.parse(decoded); } catch (e) { parsed = null; }
        if (!parsed) continue;

        var name = ((linkTag.match(/>([^<]+)<\/a>/) || [])[1] || '').trim().toLowerCase();

        // Skip servers that cannot be extracted
        if (SKIP_SERVERS.test(name)) continue;
        // Skip blogger (blogs) — cannot extract direct stream from blogger embeds
        if (/^blogs?$/i.test(name)) continue;

        var q = parsed.q || '';
        candidates.push({ parsed: parsed, name: name, q: q, qScore: _qualityScore(q) });
      }

      // Sort by quality (highest first), then by server preference
      candidates.sort(function (a, b) {
        if (b.qScore !== a.qScore) return b.qScore - a.qScore;
        var serverPrio = function (n) {
          if (/vidhide/i.test(n)) return 10;          // 229x, HLS, most reliable
          if (/odstream|odstreamhd/i.test(n)) return 9; // 149x combined, desustream
          if (/ondesu/i.test(n)) return 8;             // 75x combined (ondesu/hd/2hd/3)
          if (/moedesu/i.test(n)) return 7.5;          // moedesu & moedesuhd (googlevideo, reliable 720p/480p)
          if (/desudrive/i.test(n)) return 7;          // 43x, wraps yourupload
          if (/mp4load|mp4upload/i.test(n)) return 6;  // 41x
          if (/yourupload/i.test(n)) return 5;         // 44x
          if (/odcdn/i.test(n)) return 4;              // 26x
          if (/otakuplay|otakustream/i.test(n)) return 3; // 23x combined
          // All custom desustream embeds (desudesu, playdesu, otakuwatch, etc.)
          if (/desu|otakuwatch|updesu|odesu|playdesu/i.test(n)) return 2;
          if (/solidfiles|pdrain|filelions/i.test(n)) return 1;
          return 0; // unknown servers still get tried
        };
        return serverPrio(b.name) - serverPrio(a.name);
      });

      // Deduplicate: keep one per quality+server combination
      var selected = [];
      var seenKeys = {};
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var key = c.q + '_' + c.name;
        if (seenKeys[key]) continue;
        seenKeys[key] = 1;
        selected.push(c);
      }

      // Resolve all selected mirrors in parallel
      var tasks = selected.map(function (c) {
        var payload = { id: c.parsed.id, i: c.parsed.i, q: c.parsed.q, nonce: nonce, action: streamAction };
        return _post(SITE + '/wp-admin/admin-ajax.php', payload, episodeUrl, 6000).then(function (sRes) {
          if (!sRes || !sRes.data) return [];
          var htmlBlock = _b64Decode(sRes.data);
          var ifrSrc = (htmlBlock.match(/<iframe[^>]+src="([^"]+)"/i) || [])[1];
          if (!ifrSrc) return [];
          return _extractFromEmbed(ifrSrc, episodeUrl, 8000).then(function (mSources) {
            for (var k = 0; k < mSources.length; k++) {
              if (c.parsed.q) mSources[k].quality = c.parsed.q;
            }
            return mSources;
          });
        }).catch(function () { return []; });
      });

      return Promise.all(tasks).then(function (nested) {
        var flat = [];
        var seenUrls = {};
        for (var i = 0; i < nested.length; i++) {
          for (var j = 0; j < nested[i].length; j++) {
            var src = nested[i][j];
            if (!seenUrls[src.url]) {
              seenUrls[src.url] = 1;
              flat.push(src);
            }
          }
        }
        // Sort final results: highest quality first
        flat.sort(function (a, b) { return _qualityScore(b.quality) - _qualityScore(a.quality); });
        return flat;
      });
    }).catch(function () { return []; });
}

function getVideoSources(episodeUrl) {
  return _get(episodeUrl, SITE + '/', 8000).then(function (epHtml) {
    if (!epHtml) return Promise.reject(new Error('Otakudesu: episode page not found'));

    // Always resolve ALL mirrors from all quality tabs (360p, 480p, 720p, 1080p)
    return _resolveAllMirrors(epHtml, episodeUrl);
  }).then(function (sources) {
    if (!sources || !sources.length) throw new Error('Otakudesu: no playable stream found');
    return sources;
  });
}
