// Cinejoy — Movie & TV Series Provider for Zangetsu (https://cinejoy.pk)
//
// Fast direct HLS streams (2160p, 1080p, 720p, 360p) via shegu.st cluster.
// Zero-latency request encryption & AES-GCM decryption via enc-dec.app API.
// 100% standalone QuickJS runtime compatible (no wasm CPU hangs, no atob/btoa dependencies).

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID) : 'cinejoy';

var SITE = 'https://cinejoy.pk';
var BASE_API = 'https://api.wing.st';
var ENC_DEC_API = 'https://enc-dec.app/api';
var TMDB_BASE = 'https://api.themoviedb.org/3';
var TMDB_KEY = '8476a7ab80ad76f0936744df0430e67c';
var POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
var STILL_BASE = 'https://image.tmdb.org/t/p/w300';
var BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function getInfo() {
  return {
    name: 'Cinejoy',
    lang: 'en',
    baseUrl: SITE,
    logo: SITE + '/favicon-48.png',
    type: 'movie',
    version: '1.0.5'
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _trim(s) {
  return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
}

function _utf8Encode(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push((c >> 6) | 192, (c & 63) | 128);
    else bytes.push((c >> 12) | 224, ((c >> 6) & 63) | 128, (c & 63) | 128);
  }
  return new Uint8Array(bytes);
}

function _utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  var str = '';
  for (var i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return decodeURIComponent(escape(str));
}

function _base64ToBytes(b64) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var lookup = new Uint8Array(128);
  for (var i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  var s = String(b64).replace(/[^A-Za-z0-9+/]/g, '');
  var n = s.length;
  var p = s.charAt(n - 1) === '=' ? (s.charAt(n - 2) === '=' ? 2 : 1) : 0;
  var out = new Uint8Array((n * 3 >> 2) - p);
  for (var i = 0, j = 0; i < n; i += 4) {
    var e1 = lookup[s.charCodeAt(i)], e2 = lookup[s.charCodeAt(i + 1)];
    var e3 = lookup[s.charCodeAt(i + 2)], e4 = lookup[s.charCodeAt(i + 3)];
    out[j++] = (e1 << 2) | (e2 >> 4);
    if (j < out.length) out[j++] = ((e2 & 15) << 4) | (e3 >> 2);
    if (j < out.length) out[j++] = ((e3 & 3) << 6) | e4;
  }
  return out;
}

function _base64UrlToBytes(str) {
  var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  var pad = (4 - (s.length % 4)) % 4;
  if (pad) s += '===='.slice(0, pad);
  return _base64ToBytes(s);
}

function _bytesToBase64(bytes) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '', i = 0, len = bytes.length;
  while (i < len) {
    var c1 = bytes[i++], c2 = i < len ? bytes[i++] : NaN, c3 = i < len ? bytes[i++] : NaN;
    out += chars.charAt(c1 >> 2) + chars.charAt(((c1 & 3) << 4) | (c2 >> 4))
        + (isNaN(c2) ? '=' : chars.charAt(((c2 & 15) << 2) | (c3 >> 6)))
        + (isNaN(c3) ? '=' : chars.charAt(c3 & 63));
  }
  return out;
}

function _bytesToBase64Url(bytes) {
  return _bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _get(url, ref, timeoutMs) {
  var h = {
    'User-Agent': UA,
    'Referer': ref || SITE + '/'
  };
  return fetch(url, { headers: h, timeoutMs: timeoutMs || 8000 })
    .then(function (r) {
      if (!r) return '';
      if (typeof r === 'string') return r;
      if (typeof r.body === 'string') return r.body;
      if (typeof r.text === 'function') return r.text();
      return '';
    })
    .catch(function () { return ''; });
}

function _getJson(url, ref, timeoutMs) {
  return _get(url, ref, timeoutMs).then(function (body) {
    try {
      return JSON.parse(body || 'null');
    } catch (e) {
      return null;
    }
  });
}

// ── Pure JS AES-256-GCM Decryptor ────────────────────────────────────────────
function aesGcmDecrypt(ciphertextWithTag, keyBytes, ivBytes) {
  var ctLen = ciphertextWithTag.length - 16;
  if (ctLen < 0) throw new Error('Ciphertext too short');
  var ct = ciphertextWithTag.subarray(0, ctLen);
  var S = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
  ];
  var Rcon = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
  var w = new Uint32Array(60);
  for (var i = 0; i < 8; i++) {
    w[i] = (keyBytes[4*i] << 24) | (keyBytes[4*i+1] << 16) | (keyBytes[4*i+2] << 8) | keyBytes[4*i+3];
  }
  for (var i = 8; i < 60; i++) {
    var temp = w[i - 1];
    if (i % 8 === 0) {
      temp = ((S[(temp >>> 16) & 0xff] << 24) |
              (S[(temp >>> 8) & 0xff] << 16) |
              (S[temp & 0xff] << 8) |
              S[(temp >>> 24) & 0xff]) ^ (Rcon[i / 8] << 24);
    } else if (i % 8 === 4) {
      temp = (S[(temp >>> 24) & 0xff] << 24) |
             (S[(temp >>> 16) & 0xff] << 16) |
             (S[(temp >>> 8) & 0xff] << 8) |
             S[temp & 0xff];
    }
    w[i] = (w[i - 8] ^ temp) >>> 0;
  }
  function xtime(a) { return ((a << 1) ^ (((a >>> 7) & 1) * 0x11b)) & 0xff; }
  function aesEncryptBlock(blockIn, blockOut) {
    var s0 = (blockIn[0] << 24) | (blockIn[1] << 16) | (blockIn[2] << 8) | blockIn[3];
    var s1 = (blockIn[4] << 24) | (blockIn[5] << 16) | (blockIn[6] << 8) | blockIn[7];
    var s2 = (blockIn[8] << 24) | (blockIn[9] << 16) | (blockIn[10] << 8) | blockIn[11];
    var s3 = (blockIn[12] << 24) | (blockIn[13] << 16) | (blockIn[14] << 8) | blockIn[15];
    s0 ^= w[0]; s1 ^= w[1]; s2 ^= w[2]; s3 ^= w[3];
    for (var round = 1; round < 14; round++) {
      var t0 = (S[(s0 >>> 24) & 0xff] << 24) | (S[(s1 >>> 16) & 0xff] << 16) | (S[(s2 >>> 8) & 0xff] << 8) | S[s3 & 0xff];
      var t1 = (S[(s1 >>> 24) & 0xff] << 24) | (S[(s2 >>> 16) & 0xff] << 16) | (S[(s3 >>> 8) & 0xff] << 8) | S[s0 & 0xff];
      var t2 = (S[(s2 >>> 24) & 0xff] << 24) | (S[(s3 >>> 16) & 0xff] << 16) | (S[(s0 >>> 8) & 0xff] << 8) | S[s1 & 0xff];
      var t3 = (S[(s3 >>> 24) & 0xff] << 24) | (S[(s0 >>> 16) & 0xff] << 16) | (S[(s1 >>> 8) & 0xff] << 8) | S[s2 & 0xff];
      function mc(c) {
        var b0 = (c >>> 24) & 0xff, b1 = (c >>> 16) & 0xff, b2 = (c >>> 8) & 0xff, b3 = c & 0xff;
        return ((xtime(b0) ^ xtime(b1) ^ b1 ^ b2 ^ b3) << 24) |
               ((b0 ^ xtime(b1) ^ xtime(b2) ^ b2 ^ b3) << 16) |
               ((b0 ^ b1 ^ xtime(b2) ^ xtime(b3) ^ b3) << 8) |
               (xtime(b0) ^ b0 ^ b1 ^ b2 ^ xtime(b3)) >>> 0;
      }
      var rw = round * 4;
      s0 = (mc(t0) ^ w[rw]) >>> 0;
      s1 = (mc(t1) ^ w[rw + 1]) >>> 0;
      s2 = (mc(t2) ^ w[rw + 2]) >>> 0;
      s3 = (mc(t3) ^ w[rw + 3]) >>> 0;
    }
    var t0 = (S[(s0 >>> 24) & 0xff] << 24) | (S[(s1 >>> 16) & 0xff] << 16) | (S[(s2 >>> 8) & 0xff] << 8) | S[s3 & 0xff];
    var t1 = (S[(s1 >>> 24) & 0xff] << 24) | (S[(s2 >>> 16) & 0xff] << 16) | (S[(s3 >>> 8) & 0xff] << 8) | S[s0 & 0xff];
    var t2 = (S[(s2 >>> 24) & 0xff] << 24) | (S[(s3 >>> 16) & 0xff] << 16) | (S[(s0 >>> 8) & 0xff] << 8) | S[s1 & 0xff];
    var t3 = (S[(s3 >>> 24) & 0xff] << 24) | (S[(s0 >>> 16) & 0xff] << 16) | (S[(s1 >>> 8) & 0xff] << 8) | S[s2 & 0xff];
    s0 = (t0 ^ w[56]) >>> 0; s1 = (t1 ^ w[57]) >>> 0; s2 = (t2 ^ w[58]) >>> 0; s3 = (t3 ^ w[59]) >>> 0;
    blockOut[0] = (s0 >>> 24) & 0xff; blockOut[1] = (s0 >>> 16) & 0xff; blockOut[2] = (s0 >>> 8) & 0xff; blockOut[3] = s0 & 0xff;
    blockOut[4] = (s1 >>> 24) & 0xff; blockOut[5] = (s1 >>> 16) & 0xff; blockOut[6] = (s1 >>> 8) & 0xff; blockOut[7] = s1 & 0xff;
    blockOut[8] = (s2 >>> 24) & 0xff; blockOut[9] = (s2 >>> 16) & 0xff; blockOut[10] = (s2 >>> 8) & 0xff; blockOut[11] = s2 & 0xff;
    blockOut[12] = (s3 >>> 24) & 0xff; blockOut[13] = (s3 >>> 16) & 0xff; blockOut[14] = (s3 >>> 8) & 0xff; blockOut[15] = s3 & 0xff;
  }
  var J0 = new Uint8Array(16);
  J0.set(ivBytes); J0[15] = 1;
  var plaintext = new Uint8Array(ctLen);
  var counter = new Uint8Array(16); counter.set(J0);
  function incCounter(ctr) {
    for (var c = 15; c >= 12; c--) {
      ctr[c] = (ctr[c] + 1) & 0xff;
      if (ctr[c] !== 0) break;
    }
  }
  var keystream = new Uint8Array(16);
  var offset = 0;
  while (offset < ctLen) {
    incCounter(counter);
    aesEncryptBlock(counter, keystream);
    var blockLen = Math.min(16, ctLen - offset);
    for (var k = 0; k < blockLen; k++) plaintext[offset + k] = ct[offset + k] ^ keystream[k];
    offset += blockLen;
  }
  return plaintext;
}

// ── Catalog Cards ─────────────────────────────────────────────────────────────
function _mapCard(item) {
  if (!item || (!item.id && !item.title && !item.name)) return null;
  var isTv = (item.media_type === 'tv') || (!item.title && !!item.name);
  var mediaType = isTv ? 'tv' : 'movie';
  var title = _trim(item.title || item.name || 'Untitled');
  var url = SITE + '/watch/' + mediaType + '/' + item.id;
  var cover = item.poster_path ? (POSTER_BASE + item.poster_path) : null;
  return {
    id: url,
    title: title,
    cover: cover,
    url: url,
    type: 'movie',
    sourceId: SOURCE_ID
  };
}

// ── Home ──────────────────────────────────────────────────────────────────────
function getHome(opts) {
  var sections = [
    { title: 'Trending Today', path: '/trending/all/day' },
    { title: 'Popular Movies', path: '/movie/popular' },
    { title: 'Popular TV Series', path: '/tv/popular' },
    { title: 'Top Rated Movies', path: '/movie/top_rated' }
  ];

  var tasks = sections.map(function (sec) {
    var url = TMDB_BASE + sec.path + '?api_key=' + TMDB_KEY;
    return _getJson(url, SITE + '/', 6000).then(function (data) {
      var items = [];
      if (data && Array.isArray(data.results)) {
        for (var i = 0; i < data.results.length; i++) {
          var card = _mapCard(data.results[i]);
          if (card) items.push(card);
        }
      }
      return { title: sec.title, items: items };
    }).catch(function () {
      return { title: sec.title, items: [] };
    });
  });

  return Promise.all(tasks);
}

// ── Search ────────────────────────────────────────────────────────────────────
function search(query, page, opts) {
  var p = parseInt(page, 10) || 1;
  var q = _trim(query);
  if (!q) return Promise.resolve([]);

  var url = TMDB_BASE + '/search/multi?api_key=' + TMDB_KEY +
    '&query=' + encodeURIComponent(q) +
    '&page=' + p +
    '&include_adult=false';

  return _getJson(url, SITE + '/', 6000).then(function (data) {
    var results = [];
    if (data && Array.isArray(data.results)) {
      for (var i = 0; i < data.results.length; i++) {
        var item = data.results[i];
        if (item.media_type !== 'movie' && item.media_type !== 'tv') continue;
        var card = _mapCard(item);
        if (card) results.push(card);
      }
    }
    return results;
  }).catch(function () {
    return [];
  });
}

// ── Detail & Episodes ─────────────────────────────────────────────────────────
function _parseUrl(url) {
  var mMovie = String(url).match(/\/watch\/movie\/(\d+)/i);
  if (mMovie) return { type: 'movie', tmdbId: mMovie[1] };

  var mTv = String(url).match(/\/watch\/tv\/(\d+)(?:\/(\d+))?(?:\/(\d+))?/i);
  if (mTv) {
    return {
      type: 'tv',
      tmdbId: mTv[1],
      season: mTv[2] ? parseInt(mTv[2], 10) : 1,
      episode: mTv[3] ? parseInt(mTv[3], 10) : 1
    };
  }
  return { type: 'movie', tmdbId: null };
}

function getDetail(url, opts) {
  var parsed = _parseUrl(url);
  var isTv = parsed.type === 'tv';
  var tmdbId = parsed.tmdbId;

  if (!tmdbId) {
    return Promise.reject(new Error('Cinejoy: Invalid URL structure'));
  }

  var endpoint = isTv ? ('/tv/' + tmdbId) : ('/movie/' + tmdbId);
  var detailUrl = TMDB_BASE + endpoint + '?api_key=' + TMDB_KEY + '&append_to_response=external_ids';

  return _getJson(detailUrl, SITE + '/', 6000).then(function (data) {
    if (!data) throw new Error('Cinejoy: Failed to fetch TMDB details');

    var title = _trim(isTv ? (data.name || data.original_name) : (data.title || data.original_title));
    var desc = _trim(data.overview || '');
    var cover = data.poster_path ? (POSTER_BASE + data.poster_path) : null;
    var year = (isTv ? data.first_air_date : data.release_date || '').slice(0, 4);
    var genres = (data.genres || []).map(function (g) { return g.name; });
    var imdbId = (data.external_ids && data.external_ids.imdb_id) || null;

    if (!isTv) {
      var ep = {
        id: 'movie',
        number: 1,
        title: title,
        url: url,
        thumbnail: data.backdrop_path ? (STILL_BASE + data.backdrop_path) : cover,
        date: data.release_date || null
      };
      return {
        id: url,
        title: title,
        cover: cover,
        url: url,
        description: desc,
        status: data.status || 'Released',
        genres: genres,
        studios: (data.production_companies || []).map(function (p) { return p.name; }),
        type: 'movie',
        sourceId: SOURCE_ID,
        episodes: [ep],
        year: year,
        subCount: 1,
        dubCount: 0,
        tmdbId: parseInt(tmdbId, 10) || null,
        tmdbIsTv: false,
        imdbId: imdbId
      };
    }

    // TV Series: seasons & episodes
    var rawSeasons = Array.isArray(data.seasons) ? data.seasons : [];
    var validSeasons = rawSeasons.filter(function (s) {
      return s.season_number != null && s.season_number > 0;
    });

    if (!validSeasons.length && rawSeasons.length > 0) {
      validSeasons = rawSeasons;
    }

    var seasonJobs = validSeasons.map(function (s) {
      var sNum = s.season_number;
      var sUrl = TMDB_BASE + '/tv/' + tmdbId + '/season/' + sNum + '?api_key=' + TMDB_KEY;
      return _getJson(sUrl, SITE + '/', 6000).then(function (sData) {
        return {
          seasonNumber: sNum,
          episodes: (sData && Array.isArray(sData.episodes)) ? sData.episodes : []
        };
      }).catch(function () {
        return { seasonNumber: sNum, episodes: [] };
      });
    });

    return Promise.all(seasonJobs).then(function (seasonResults) {
      var allEpisodes = [];
      var epCounter = 1;

      for (var i = 0; i < seasonResults.length; i++) {
        var sInfo = seasonResults[i];
        var sNum = sInfo.seasonNumber;
        for (var j = 0; j < sInfo.episodes.length; j++) {
          var ep = sInfo.episodes[j];
          var epNum = ep.episode_number;
          var epTitle = 'S' + sNum + ' E' + epNum + (ep.name ? (' - ' + ep.name) : '');
          var epUrl = SITE + '/watch/tv/' + tmdbId + '/' + sNum + '/' + epNum;
          allEpisodes.push({
            id: 's' + sNum + 'e' + epNum,
            number: epCounter++,
            title: epTitle,
            url: epUrl,
            thumbnail: ep.still_path ? (STILL_BASE + ep.still_path) : null,
            date: ep.air_date || null
          });
        }
      }

      return {
        id: url,
        title: title,
        cover: cover,
        url: url,
        description: desc,
        status: data.status || 'Returning Series',
        genres: genres,
        studios: (data.production_companies || []).map(function (p) { return p.name; }),
        type: 'movie',
        sourceId: SOURCE_ID,
        episodes: allEpisodes,
        year: year,
        subCount: allEpisodes.length,
        dubCount: 0,
        tmdbId: parseInt(tmdbId, 10) || null,
        tmdbIsTv: true,
        imdbId: imdbId
      };
    });
  });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) {
    return (d && d.episodes) || [];
  });
}

// ── Stream Extraction ─────────────────────────────────────────────────────────
function _normalizeLang(rawLang, url) {
  var l = String(rawLang || '').toLowerCase().replace(/^\s+|\s+$/g, '');
  var u = String(url || '').toLowerCase();
  if (l === 'en' || l === 'eng' || u.indexOf('_eng_') !== -1) return { lang: 'en', label: 'English' };
  if (l === 'id' || l === 'ind' || l === 'ina' || u.indexOf('_ind_') !== -1 || u.indexOf('_ina_') !== -1) return { lang: 'id', label: 'Indonesian' };
  if (l === 'fr' || l === 'fre' || l === 'fra' || u.indexOf('_fre_') !== -1 || u.indexOf('_fra_') !== -1) return { lang: 'fr', label: 'French' };
  if (l === 'es' || l === 'spa' || u.indexOf('_spa_') !== -1) return { lang: 'es', label: 'Spanish' };
  if (l === 'de' || l === 'ger' || l === 'deu' || u.indexOf('_ger_') !== -1 || u.indexOf('_deu_') !== -1) return { lang: 'de', label: 'German' };
  if (l === 'ja' || l === 'jpn' || u.indexOf('_jpn_') !== -1) return { lang: 'ja', label: 'Japanese' };
  if (l === 'ko' || l === 'kor' || u.indexOf('_kor_') !== -1) return { lang: 'ko', label: 'Korean' };
  if (l === 'zh' || l === 'chi' || u.indexOf('_chi_') !== -1) return { lang: 'zh', label: 'Chinese' };
  if (l === 'pt' || l === 'por' || u.indexOf('_por_') !== -1) return { lang: 'pt', label: 'Portuguese' };
  if (l === 'ar' || l === 'ara' || u.indexOf('_ara_') !== -1) return { lang: 'ar', label: 'Arabic' };
  if (l === 'ru' || l === 'rus' || u.indexOf('_rus_') !== -1) return { lang: 'ru', label: 'Russian' };
  return { lang: l || 'und', label: rawLang || 'Unknown' };
}

function _extractServerPayload(serverName, dec) {
  var rawStreams = [];
  var rawCaptions = [];

  if (!dec || !dec.data) return { serverName: serverName, streams: rawStreams, captions: rawCaptions };
  var streams = dec.data.stream;
  if (!Array.isArray(streams)) return { serverName: serverName, streams: rawStreams, captions: rawCaptions };

  for (var j = 0; j < streams.length; j++) {
    var st = streams[j];
    if (!st) continue;

    // Captions
    if (Array.isArray(st.captions)) {
      for (var c = 0; c < st.captions.length; c++) {
        var cap = st.captions[c];
        if (cap && cap.url) {
          rawCaptions.push(cap);
        }
      }
    }

    // HLS playlist
    var m3u8Url = st.playlist || st.url;
    if (m3u8Url) {
      rawStreams.push({
        url: m3u8Url,
        type: 'hls',
        id: st.id || ''
      });
    }

    // Direct multi-quality files
    if (st.qualities && typeof st.qualities === 'object') {
      var qKeys = Object.keys(st.qualities);
      for (var q = 0; q < qKeys.length; q++) {
        var qKey = qKeys[q];
        var qObj = st.qualities[qKey];
        if (qObj && qObj.url && /^https?:\/\//i.test(qObj.url)) {
          rawStreams.push({
            url: qObj.url,
            type: qObj.type === 'mp4' ? 'mp4' : 'hls',
            quality: qKey + 'p',
            id: st.id || ''
          });
        }
      }
    }
  }

  return {
    serverName: serverName,
    streams: rawStreams,
    captions: rawCaptions
  };
}

function _parseMasterPlaylist(masterUrl, serverName, subtitles) {
  return fetch(masterUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': SITE + '/'
    }
  }).then(function (res) {
    if (!res.ok) return [];
    var getText = typeof res.text === 'function'
      ? res.text()
      : Promise.resolve(res.body || '');
    return getText.then(function (text) {
      if (!text || typeof text !== 'string') return [];
      var lines = text.split('\n');
      var baseUrl = masterUrl.substring(0, masterUrl.indexOf('/', 8));
      var results = [];
      for (var i = 0; i < lines.length; i++) {
        var line = _trim(lines[i]);
        if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
          var quality = 'Auto';
          var resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
          if (resMatch) {
            var w = parseInt(resMatch[1], 10);
            var h = parseInt(resMatch[2], 10);
            if (h >= 1000 || w >= 1900) quality = '1080p';
            else if (h >= 700 || w >= 1200) quality = '720p';
            else if (h >= 450) quality = '480p';
            else quality = '360p';
          }
          var nextLine = _trim(lines[i + 1] || '');
          if (nextLine && nextLine.indexOf('#') !== 0) {
            var streamUrl = nextLine;
            if (streamUrl.indexOf('/') === 0) {
              streamUrl = baseUrl + streamUrl;
            } else if (streamUrl.indexOf('http') !== 0) {
              var lastSlash = masterUrl.lastIndexOf('/');
              streamUrl = masterUrl.substring(0, lastSlash + 1) + streamUrl;
            }
            results.push({
              url: streamUrl,
              quality: quality,
              container: 'hls',
              headers: { 'User-Agent': UA, 'Referer': SITE + '/' },
              subtitles: subtitles || [],
              label: 'Cinejoy - ' + serverName + ' (' + quality + ')'
            });
          }
        }
      }
      return results;
    });
  }).catch(function () {
    return [];
  });
}

function getVideoSources(episodeUrl, opts) {
  var parsed = _parseUrl(episodeUrl);
  var isTv = parsed.type === 'tv';
  var tmdbId = parsed.tmdbId;
  var season = parsed.season || 1;
  var episode = parsed.episode || 1;

  if (!tmdbId) {
    return Promise.reject(new Error('Cinejoy: Invalid TMDB ID in episode URL'));
  }

  var isFast = !!(opts && opts.fast);

  function fetchServerData(serverName) {
    var reqUrl = BASE_API + '/?' + (isTv
      ? 'type=series&tmdb=' + encodeURIComponent(tmdbId) + '&season=' + encodeURIComponent(season) + '&episode=' + encodeURIComponent(episode) + '&server=' + encodeURIComponent(serverName)
      : 'type=movie&tmdb=' + encodeURIComponent(tmdbId) + '&server=' + encodeURIComponent(serverName));

    return fetch(ENC_DEC_API + '/enc-cinejoy?url=' + encodeURIComponent(reqUrl)).then(function (encRes) {
      if (!encRes || !encRes.ok) return { serverName: serverName, streams: [], captions: [] };
      return encRes.json().then(function (encJson) {
        if (!encJson || encJson.status !== 200 || !encJson.result || !encJson.result.data) {
          return { serverName: serverName, streams: [], captions: [] };
        }

        var rawBody = _base64UrlToBytes(encJson.result.data);
        var state = encJson.result.state;

        return fetch(BASE_API + '/g', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'User-Agent': UA,
            'Origin': SITE,
            'Referer': SITE + '/'
          },
          body: rawBody,
          responseType: 'arraybuffer'
        }).then(function (res) {
          if (!res || !res.ok) return { serverName: serverName, streams: [], captions: [] };
          var getBuf = typeof res.arrayBuffer === 'function'
            ? res.arrayBuffer()
            : Promise.resolve(res.bytes ? res.bytes() : (res.bodyB64 ? _base64ToBytes(res.bodyB64) : null));

          return getBuf.then(function (buf) {
            if (!buf) return { serverName: serverName, streams: [], captions: [] };
            var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            var decryptedObj = null;

            // Fast pure JS AES-GCM local decryption
            try {
              if (state && state.responseKey) {
                var respKey = _base64UrlToBytes(state.responseKey);
                var iv = bytes.subarray(0, 12);
                var ctAndTag = bytes.subarray(12);
                var decBytes = aesGcmDecrypt(ctAndTag, respKey, iv);
                var decStr = _utf8Decode(decBytes);
                decryptedObj = JSON.parse(decStr);
              }
            } catch (e) {}

            if (decryptedObj && decryptedObj.data) {
              return _extractServerPayload(serverName, decryptedObj);
            }

            // Fallback to remote dec-cinejoy endpoint if local decryption didn't produce streams
            return fetch(ENC_DEC_API + '/dec-cinejoy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: _bytesToBase64Url(bytes),
                state: state
              })
            }).then(function (decRes) {
              if (!decRes || !decRes.ok) return { serverName: serverName, streams: [], captions: [] };
              return decRes.json().then(function (decJson) {
                if (decJson && decJson.status === 200 && decJson.result) {
                  return _extractServerPayload(serverName, decJson.result);
                }
                return { serverName: serverName, streams: [], captions: [] };
              });
            }).catch(function () {
              return { serverName: serverName, streams: [], captions: [] };
            });
          });
        });
      });
    }).catch(function () {
      return { serverName: serverName, streams: [], captions: [] };
    });
  }

  // All official Cinejoy/Shegu servers
  var candidateServers = isFast
    ? ['Solara', 'Nebula']
    : ['Solara', 'Lisbon', 'Nebula', 'Athens', 'Castle', 'Joy', 'Sakura'];

  var fetchJobs = candidateServers.map(function (s) {
    return fetchServerData(s);
  });

  return Promise.all(fetchJobs).then(function (serverResults) {
    // 1. Collect and deduplicate all subtitles across all returned servers
    var allSubtitles = [];
    var seenSubUrls = {};

    for (var i = 0; i < serverResults.length; i++) {
      var sr = serverResults[i];
      if (!sr || !Array.isArray(sr.captions)) continue;
      for (var c = 0; c < sr.captions.length; c++) {
        var cap = sr.captions[c];
        if (cap && cap.url && !seenSubUrls[cap.url]) {
          seenSubUrls[cap.url] = 1;
          var norm = _normalizeLang(cap.language || cap.lang, cap.url);
          allSubtitles.push({
            lang: norm.lang,
            label: norm.label,
            url: cap.url
          });
        }
      }
    }

    // 2. Build video sources
    var masterParseJobs = [];
    var baseSources = [];
    var seenStreamUrls = {};

    for (var j = 0; j < serverResults.length; j++) {
      var resItem = serverResults[j];
      if (!resItem || !Array.isArray(resItem.streams)) continue;
      var sName = resItem.serverName;

      for (var k = 0; k < resItem.streams.length; k++) {
        var streamItem = resItem.streams[k];
        if (!streamItem || !streamItem.url || seenStreamUrls[streamItem.url]) continue;
        seenStreamUrls[streamItem.url] = 1;

        if (streamItem.type === 'hls') {
          var pathOnly = streamItem.url.split('?')[0];
          var is4k = /(?:[_\-\/]4k|2160p|uhd)/i.test(pathOnly) || (streamItem.id && /4k/i.test(streamItem.id));

          // Solara and Nebula have self-contained multiplexed HLS playlists that can be split into discrete resolutions
          if (sName === 'Solara' || sName === 'Nebula') {
            masterParseJobs.push(
              _parseMasterPlaylist(streamItem.url, sName, allSubtitles)
            );
          }

          baseSources.push({
            url: streamItem.url,
            quality: is4k ? '2160p' : 'Auto',
            container: 'hls',
            headers: { 'User-Agent': UA, 'Referer': SITE + '/' },
            subtitles: allSubtitles,
            label: 'Cinejoy - ' + sName + ' (' + (is4k ? '4K HLS' : 'Master HLS') + ')'
          });
        } else {
          // Direct file (e.g. mp4)
          baseSources.push({
            url: streamItem.url,
            quality: streamItem.quality || 'Auto',
            container: streamItem.type || 'mp4',
            headers: { 'User-Agent': UA, 'Referer': SITE + '/' },
            subtitles: allSubtitles,
            label: 'Cinejoy - ' + sName + ' (' + (streamItem.quality || 'MP4') + ')'
          });
        }
      }
    }

    return Promise.all(masterParseJobs).then(function (discreteListArray) {
      var discreteSources = [];
      for (var d = 0; d < discreteListArray.length; d++) {
        var dList = discreteListArray[d];
        if (Array.isArray(dList)) {
          for (var dl = 0; dl < dList.length; dl++) {
            discreteSources.push(dList[dl]);
          }
        }
      }

      var allSources = discreteSources.concat(baseSources);

      if (!allSources.length) {
        return Promise.reject(new Error('Cinejoy: No playable stream sources found'));
      }

      var rank = { '2160p': 5, '1080p': 4, '720p': 3, '480p': 2, '360p': 1, 'Auto': 0 };
      var serverPref = { 'Solara': 1, 'Nebula': 2, 'Lisbon': 3, 'Athens': 4, 'Castle': 5, 'Joy': 6, 'Sakura': 7 };

      allSources.sort(function (a, b) {
        var rDiff = (rank[b.quality] || 0) - (rank[a.quality] || 0);
        if (rDiff !== 0) return rDiff;
        var aMatch = a.label.match(/Cinejoy - ([A-Za-z]+)/);
        var bMatch = b.label.match(/Cinejoy - ([A-Za-z]+)/);
        var aPref = aMatch ? (serverPref[aMatch[1]] || 99) : 99;
        var bPref = bMatch ? (serverPref[bMatch[1]] || 99) : 99;
        return aPref - bPref;
      });

      return allSources;
    });
  });
}

