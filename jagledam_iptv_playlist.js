/*
 * JaGledam -> IPTV playlist (M3U) generator
 * -------------------------------------------------------------
 * HOW TO USE
 *   1. Open https://www.jagledam.com/ (home page).
 *   2. F12 -> Console  (Chrome/Edge: type  allow pasting  + Enter first).
 *   3. Paste this whole script + Enter. Keep the tab open until the .m3u downloads.
 *
 * WHAT IT DOES
 *   1. Finds every channel page (same crawler as the first script).
 *   2. Collects the logo, category, country and all player pages (/k186/…, /k235/…).
 *   3. RESOLVES each player page to the real stream URL (.m3u8 / .mpd):
 *        a) static  – reads the page source: .m3u8/.mpd, <video>/<source> tags, player configs
 *                     (file:/src:/url:), bare http://IP:port/… streams (no file extension),
 *                     escaped/base64 URLs and nested same-origin iframes
 *        b) runtime – fallback: loads the page in a hidden sandboxed iframe and watches
 *                     which .m3u8/.mpd it requests (same-origin only)
 *   4. Writes an iptv-org style playlist:
 *        #EXTINF:-1 tvg-id="" tvg-logo="…" group-title="…",Channel
 *        #EXTVLCOPT:http-referrer=…
 *        https://…/index.m3u8
 *
 * A SELF-TEST runs first on ~6 streams. If none can be resolved, the script stops and prints
 * what the player pages look like (window.jagledamDebug) instead of wasting 10+ minutes.
 *
 * STOP EARLY: window.__jgStop = true      RESULT DATA: window.jagledamIptv
 */
(async () => {
  'use strict';

  /* ───────────────────────── CONFIG ───────────────────────── */
  const CONFIG = {
    GROUP_BY: 'category',        // 'category' (Sportski, Filmski …) | 'country'
    KEEP_ALL_LINKS: true,        // true = every working link becomes an entry; false = only the first per channel
    MARK_ALT_LINKS: true,        // 2nd/3rd link of a channel is named "Name (Link 2)"
    USER_AGENT: '',              // e.g. 'Mozilla/5.0 …'  -> adds #EXTVLCOPT:http-user-agent
    ACCEPT_GUESSES: true,        // also accept extension-less URLs found in player configs / bare IP:port URLs
    RUNTIME_SNIFF: true,         // fallback b) described above (slow; set false to skip)
    SNIFF_TIMEOUT_MS: 9000,
    PREFLIGHT: true,             // self-test on a few streams first
    FORCE: false,                // true = continue even if the self-test resolves nothing
    MAX_CHANNELS: 0,             // 0 = all, e.g. 10 for a quick test
    CONCURRENCY_PAGES: 4,        // channel pages in parallel
    CONCURRENCY_RESOLVE: 6,      // player pages in parallel
    CONCURRENCY_SNIFF: 3,        // hidden iframes in parallel
    DELAY_MS: 120,
    RETRIES: 2,
    FILE_PREFIX: 'jagledam_iptv',
    REPORT_FILE: true,           // also download a small "unresolved" report if something failed
  };

  const STREAM_IFRAME_XPATH =
    '/html/body/div[1]/section/div/div[2]/div/div[1]/section[1]/div[1]/div[1]/div[3]/div[2]/iframe';

  /* ───────────────────────── HELPERS ───────────────────────── */
  const ORIGIN = location.origin;
  const log  = (...a) => console.log('%c[JaGledam]', 'color:#33485b;font-weight:bold', ...a);
  const warn = (...a) => console.warn('[JaGledam]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isJG = (host) => /(^|\.)jagledam\.com$/i.test(host);

  if (!isJG(location.hostname)) {
    console.error('[JaGledam] Please open https://www.jagledam.com/ first, then paste the script again.');
    return;
  }
  window.__jgStop = false;

  const CHANNEL_PATH_RE   = /^\/[^/]+-uzivo-stream$/i;
  const CHANNEL_LINK_RE   = /(?:https?:\/\/[^\s"'<>()\\]*?)?\/[A-Za-z0-9_%.~-]+-uzivo-stream/gi;
  const STREAM_PATH_RE    = /\/k\d+\/[0-9a-z]{16,}/i;
  const STREAM_URL_RE     = /(?:https?:\/\/[^\s"'<>\\]+)?\/k\d+\/[0-9a-z]{16,}/gi;
  const CATEGORY_RE       = /\/(domaci|djeciji|sportski|muzicki|filmski|informativni|zabavni|dokumentarni|lokalni|internacionalni|religijski)\/?$/i;
  const IGNORED_IFRAME_RE = /(disqus|facebook\.|twitter\.|platform\.x\.com|googletagmanager|doubleclick|googlesyndication|recaptcha)/i;
  const MEDIA_EXT_RE      = /\.(m3u8|mpd)(\?|#|$)/i;

  const slugName = (url) => {
    try {
      return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')).replace(/-uzivo-stream$/i, '').replace(/-+/g, ' ').trim();
    } catch { return url; }
  };
  const toChannelUrl = (href, base = location.href) => {
    try {
      const u = new URL(href, base);
      if (!isJG(u.hostname)) return null;
      const path = u.pathname.replace(/\/+$/, '');
      return CHANNEL_PATH_RE.test(path) ? ORIGIN + path : null;
    } catch { return null; }
  };

  async function fetchText(url, { retries = CONFIG.RETRIES } = {}) {
    const sameOrigin = (() => { try { return new URL(url).origin === ORIGIN; } catch { return false; } })();
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(url, { credentials: sameOrigin ? 'same-origin' : 'omit' });
        if (res.status === 404) throw Object.assign(new Error('HTTP 404'), { fatal: true });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
      } catch (e) {
        lastErr = e;
        // cross-origin failures (CORS / mixed content) will never succeed on retry
        if (e.fatal || !sameOrigin || window.__jgStop) break;
        await sleep(800 * (i + 1));
      }
    }
    throw lastErr;
  }

  async function pool(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (!window.__jgStop) {
        const k = i++;
        if (k >= items.length) return;
        await fn(items[k], k);
      }
    });
    await Promise.all(workers);
  }

  /* ───────────────── 1) FIND ALL CHANNEL PAGES ───────────────── */
  const channelSet = new Set();
  const collectFromHtml = (html, base) => {
    for (const m of html.matchAll(CHANNEL_LINK_RE)) { const u = toChannelUrl(m[0], base); if (u) channelSet.add(u); }
  };
  const collectFromDom = () => {
    document.querySelectorAll('a[href]').forEach((a) => { const u = toChannelUrl(a.getAttribute('href')); if (u) channelSet.add(u); });
    collectFromHtml(document.documentElement.outerHTML, location.href);
  };
  async function revealAllTabs() {
    const labels = ['bih', 'hrvatska', 'srbija', 'slovenija', 'crna gora', 'makedonija', 'kosovo'];
    const isSve = (el) => (el.textContent || '').trim().toLowerCase() === 'sve';
    const tabs = [...document.querySelectorAll('a[href^="#"], [role="tab"], [data-toggle="tab"], [data-bs-toggle="tab"]')]
      .filter((el) => {
        const t = (el.textContent || '').trim().toLowerCase();
        return t.length < 25 && (t === 'sve' || labels.some((l) => t.startsWith(l)));
      })
      .sort((a, b) => isSve(a) - isSve(b));
    const y0 = window.scrollY;
    for (const tab of tabs) { try { tab.click(); } catch { /* ignore */ } await sleep(500); collectFromDom(); }
    for (let i = 0; i < 6; i++) { window.scrollTo(0, document.body.scrollHeight); await sleep(250); }
    window.scrollTo(0, y0);
    collectFromDom();
  }
  async function collectFromSitemap() {
    const queue = [ORIGIN + '/sitemap.xml'], seen = new Set();
    while (queue.length && seen.size < 15) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      let xml; try { xml = await fetchText(url, { retries: 0 }); } catch { continue; }
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        const loc = m[1].replace(/&amp;/g, '&');
        if (/\.xml(\?|$)/i.test(loc)) queue.push(loc); else { const u = toChannelUrl(loc); if (u) channelSet.add(u); }
      }
    }
  }

  log('Step 1/4  Searching for channel pages …');
  collectFromDom();
  try { await revealAllTabs(); } catch (e) { warn('Tab handling failed:', e); }
  try { collectFromHtml(await fetchText(ORIGIN + '/'), ORIGIN + '/'); } catch (e) { warn('Home-page fetch failed:', e.message); }
  try { await collectFromSitemap(); } catch { /* ignore */ }
  let channels = [...channelSet];
  log(`${channels.length} channel pages found.`);
  if (!channels.length) { console.error('[JaGledam] No channel pages found – run this on the home page.'); return; }
  if (CONFIG.MAX_CHANNELS > 0) channels = channels.slice(0, CONFIG.MAX_CHANNELS);

  /* ───────────────── 2) PARSE CHANNEL PAGES ───────────────── */
  function parseChannel(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');

    let name = txt(doc.querySelector('h1')) || txt(doc.querySelector('title'));
    name = name.replace(/\s*\|\s*JaGledam.*$/i, '').replace(/\s*u[žz]ivo\s+stream.*$/i, '').trim() || slugName(pageUrl);

    const streams = new Map();
    const addStream = (raw) => {
      if (!raw) return;
      raw = String(raw).trim();
      if (!raw || raw === '#' || /^(javascript:|about:|data:|mailto:|blob:)/i.test(raw)) return;
      try {
        const u = new URL(raw, pageUrl);
        if (!/^https?:$/.test(u.protocol)) return;
        if (isJG(u.hostname) && u.protocol === 'http:') u.protocol = 'https:';
        streams.set(u.href, true);
      } catch { /* ignore */ }
    };
    const iframeSrc = (el) => {
      for (const a of ['src', 'data-src', 'data-lazy-src', 'data-url']) { const v = el.getAttribute(a); if (v && v.trim()) return v.trim(); }
      return null;
    };

    try {
      const node = doc.evaluate(STREAM_IFRAME_XPATH, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (node) addStream(iframeSrc(node));
    } catch { /* ignore */ }
    doc.querySelectorAll('iframe').forEach((f) => { const s = iframeSrc(f); if (s && !IGNORED_IFRAME_RE.test(s)) addStream(s); });
    doc.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (STREAM_PATH_RE.test(href) || /^stream\s*link/i.test(txt(a))) {
        addStream(href);
        ['data-src', 'data-url', 'data-link', 'data-stream', 'data-iframe'].forEach((k) => addStream(a.getAttribute(k)));
      }
    });
    for (const m of html.replace(/\\\//g, '/').matchAll(STREAM_URL_RE)) addStream(m[0]);

    let country = '';
    const category = [];
    const anchors = [...doc.querySelectorAll('a[href]')];
    const ci = anchors.findIndex((a) => /^(?:https?:\/\/(?:www\.)?jagledam\.com)?\/#[A-Za-z]{2,4}$/i.test(a.getAttribute('href') || ''));
    if (ci >= 0) {
      country = txt(anchors[ci]);
      for (let i = ci + 1; i < anchors.length && CATEGORY_RE.test(anchors[i].getAttribute('href') || ''); i++) category.push(txt(anchors[i]));
    }

    // logo: first /logo/ image on the page is the channel's own logo
    let logo = '';
    const img = doc.querySelector('img[src*="/logo/"], img[data-src*="/logo/"]');
    if (img) {
      const raw = (img.getAttribute('src') || '').includes('/logo/') ? img.getAttribute('src') : img.getAttribute('data-src');
      try { const u = new URL(raw, pageUrl); if (isJG(u.hostname)) u.protocol = 'https:'; logo = u.href; } catch { /* ignore */ }
    }

    return { name, country, category: category[0] || '', url: pageUrl, logo, streams: [...streams.keys()] };
  }

  log(`Step 2/4  Reading ${channels.length} channel pages …  (type  window.__jgStop = true  to abort)`);
  const crawled = new Array(channels.length);
  let doneCh = 0;
  await pool(channels, CONFIG.CONCURRENCY_PAGES, async (url, i) => {
    try { crawled[i] = parseChannel(await fetchText(url), url); }
    catch (e) { crawled[i] = { name: slugName(url), country: '', category: '', url, logo: '', streams: [], error: String((e && e.message) || e) }; }
    if (++doneCh % 25 === 0 || doneCh === channels.length) log(`  ${doneCh}/${channels.length} channel pages`);
    await sleep(CONFIG.DELAY_MS);
  });
  const rows = crawled.filter(Boolean);
  const allPages = [...new Set(rows.flatMap((r) => r.streams))];
  log(`${rows.filter((r) => r.streams.length).length} channels with ${allPages.length} unique player pages.`);

  /* ───────────────── 3) RESOLVE PLAYER PAGES -> REAL STREAM URL ───────────────── */
  const isMedia = (u) => MEDIA_EXT_RE.test(u);

  // Expand obfuscations: escaped slashes, entities, base64 literals, percent-encoded URLs
  function expandText(html) {
    const t = html.replace(/\\u0026/gi, '&').replace(/\\x26/gi, '&').replace(/\\u002F/gi, '/').replace(/\\x2F/gi, '/')
                  .replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const extra = [];
    for (const m of t.matchAll(/["'`]([A-Za-z0-9+/]{24,2000}={0,2})["'`]/g)) {
      try { const d = atob(m[1]); if (/^https?:\/\//i.test(d) || /\.(m3u8|mpd)/i.test(d)) extra.push(d); } catch { /* not base64 */ }
    }
    for (const m of t.matchAll(/https?%3A%2F%2F[^\s"'`<>&\\]+/gi)) { try { extra.push(decodeURIComponent(m[0])); } catch { /* ignore */ } }
    return t + '\n' + extra.join('\n');
  }

  const QUOTED_MEDIA_RE = /["'`]((?:https?:)?\/\/[^"'`\s<>\\]+?\.(?:m3u8|mpd)(?:\?[^"'`\s<>\\]*)?|\/?[^"'`\s<>\\:]*?\.(?:m3u8|mpd)(?:\?[^"'`\s<>\\]*)?)["'`]/gi;
  const RAW_MEDIA_RE    = /https?:\/\/[^\s"'`<>\\()]+?\.(?:m3u8|mpd)(?:\?[^\s"'`<>\\()]*)?/gi;
  // extension-less streams: player configs  (file: "http://…", src = "http://…", stream_url: "…")
  const KEY_URL_RE      = /\b(?:file|src|source|stream\w*|url|hls\w*|video\w*|link|play\w*|manifest)["']?\s*[:=]\s*\[?\s*(?:\{\s*["']?(?:src|file|url)["']?\s*:\s*)?["'`]((?:https?:)?\/\/[^"'`\s<>\\]+)["'`]/gi;
  // bare  http://1.2.3.4:1080/name  streams (typical for raw MPEG-TS over HTTP)
  const IP_URL_RE       = /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\/[^\s"'`<>\\)]*/gi;
  const JUNK_URL_RE     = /(\$\{|\{\{|%s|undefined|example\.(com|org)|w3\.org|schema\.org)/i;
  const ASSET_EXT_RE    = /\.(js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|bmp|woff2?|ttf|eot|otf|html?|xml|txt|vtt|srt)$/i;
  const SKIP_HOST_RE    = /(google|gstatic|googleapis|googletagmanager|doubleclick|facebook|fbcdn|twitter|twimg|twitch|youtube|youtu\.be|jsdelivr|cdnjs\.cloudflare|jquery|bootstrapcdn|fontawesome|disqus|jwpcdn|jwplayer|unpkg|polyfill|clappr|zencdn)/i;
  const OWN_STATIC_RE   = /^\/(assets|img|logo|logos|css|js|fonts|static|k\d+)(\/|$)/i;
  const KIND_RANK       = { hls: 0, dash: 1, 'video-tag': 2, config: 3, ip: 4 };
  const RELIABLE        = new Set(['hls', 'dash', 'video-tag']);

  // returns [{url, kind}] sorted by reliability: hls > dash > video-tag > config > ip
  function extractMedia(text, base, doc) {
    const seen = new Set(), out = [];
    const add = (raw, kind) => {
      try {
        const u = new URL(raw, base);
        if (!/^https?:$/.test(u.protocol) || JUNK_URL_RE.test(u.href)) return;
        if (kind === 'hls' || kind === 'dash') { if (!isMedia(u.href)) return; }
        else {
          if (ASSET_EXT_RE.test(u.pathname) || SKIP_HOST_RE.test(u.hostname)) return;
          if (isJG(u.hostname) && OWN_STATIC_RE.test(u.pathname)) return;
          if ((u.pathname === '/' || u.pathname === '') && !u.search) return;
          if (u.href === base) return;
        }
        if (seen.has(u.href)) return;
        seen.add(u.href);
        out.push({ url: u.href, kind: kind === 'hls' && !/\.m3u8(\?|#|$)/i.test(u.href) ? 'dash' : kind });
      } catch { /* ignore */ }
    };
    for (const m of text.matchAll(QUOTED_MEDIA_RE)) add(m[1], /\.mpd(\?|#|$)/i.test(m[1]) ? 'dash' : 'hls');
    for (const m of text.matchAll(RAW_MEDIA_RE)) add(m[0], /\.mpd(\?|#|$)/i.test(m[0]) ? 'dash' : 'hls');
    if (doc) doc.querySelectorAll('video[src], video source[src], audio[src], audio source[src]').forEach((el) => add(el.getAttribute('src'), 'video-tag'));
    const stripped = text.replace(/<(?:iframe|script|img|link|a|meta)\b[^>]*>/gi, ' ');   // keep inline script bodies, drop asset/embed tags
    for (const m of stripped.matchAll(KEY_URL_RE)) add(m[1], 'config');
    for (const m of stripped.matchAll(IP_URL_RE)) add(m[0], 'ip');
    return out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  }

  const refererFor = (pageUrl) => { try { return new URL(pageUrl).origin + '/'; } catch { return ORIGIN + '/'; } };

  async function resolveStatic(url, depth = 0, trail = []) {
    if (isMedia(url)) return { media: url, referer: ORIGIN + '/', via: 'direct' };
    let html;
    try { html = await fetchText(url); }
    catch (e) { return { error: 'fetch failed (' + ((e && e.message) || e) + ')', embed: url }; }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const found = extractMedia(expandText(html), url, doc);
    const pick = found.find((f) => RELIABLE.has(f.kind)) || (CONFIG.ACCEPT_GUESSES ? found[0] : null);
    if (pick) {
      return {
        media: pick.url, referer: refererFor(url),
        via: RELIABLE.has(pick.kind) && pick.kind !== 'video-tag' ? 'static' : 'static-' + pick.kind,
        alternatives: found.filter((f) => f !== pick).slice(0, 3).map((f) => f.url),
      };
    }

    let lastEmbed = url;
    if (depth < 2) {
      const srcs = [...doc.querySelectorAll('iframe')]
        .map((f) => f.getAttribute('src') || f.getAttribute('data-src') || '')
        .filter((s) => s && !IGNORED_IFRAME_RE.test(s) && !/^(about:|javascript:)/i.test(s));
      for (const s of srcs) {
        let abs; try { abs = new URL(s, url).href; } catch { continue; }
        if (trail.includes(abs)) continue;
        const r = await resolveStatic(abs, depth + 1, [...trail, url]);
        if (r.media) return r;
        lastEmbed = r.embed || abs;
      }
    }
    const why = /(player|embed)\.twitch\.tv|twitch-embed/i.test(html) ? 'Twitch embed (no direct stream URL)'
              : /youtube(-nocookie)?\.com\/embed|youtu\.be/i.test(html) ? 'YouTube embed (no direct stream URL)'
              : 'no stream URL found in page source';
    return { error: why, embed: lastEmbed, html };
  }

  // Runtime fallback: load the page in a hidden, sandboxed same-origin iframe and watch its requests
  function runtimeSniff(url) {
    return new Promise((resolve) => {
      let u; try { u = new URL(url); } catch { return resolve(null); }
      if (u.origin !== ORIGIN) return resolve(null);          // cross-origin: browser does not expose the requests
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;border:0;opacity:0;pointer-events:none';
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin');   // no popups, no top-navigation
      let finished = false, timer, to;
      const finish = (val) => {
        if (finished) return; finished = true;
        clearInterval(timer); clearTimeout(to); try { f.remove(); } catch { /* ignore */ }
        resolve(val);
      };
      timer = setInterval(() => {
        try {
          const entries = f.contentWindow.performance.getEntriesByType('resource');
          const hit = entries.find((e) => isMedia(e.name) && !JUNK_URL_RE.test(e.name))
                   || entries.find((e) => /^(video|audio)$/.test(e.initiatorType) && !JUNK_URL_RE.test(e.name));
          if (hit) finish(hit.name);
        } catch { /* not readable yet */ }
      }, 400);
      to = setTimeout(() => finish(null), CONFIG.SNIFF_TIMEOUT_MS);
      f.src = url;
      document.body.appendChild(f);
    });
  }

  const resolved = new Map();      // player page URL -> result
  const sniffed = new Set();       // player pages already tried with the runtime fallback
  const htmlSamples = new Map();   // for diagnostics

  async function resolveOne(url) {
    let r = await resolveStatic(url);
    if (r.html) htmlSamples.set(url, r.html);
    if (!r.media && CONFIG.RUNTIME_SNIFF) {
      sniffed.add(url);
      const hit = await runtimeSniff(url);
      if (hit) r = { media: hit, referer: refererFor(url), via: 'runtime' };
    }
    delete r.html;
    resolved.set(url, r);
    return r;
  }

  function diagnose(url, html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    return {
      url,
      htmlLength: (html || '').length,
      title: doc.title,
      iframes: [...doc.querySelectorAll('iframe')].map((f) => f.getAttribute('src') || f.getAttribute('data-src')),
      scriptSrc: [...doc.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')),
      inlineScriptHints: [...doc.querySelectorAll('script:not([src])')]
        .map((s) => s.textContent.trim()).filter((t) => /player|source|file|hls|stream|m3u8|mpd|atob|eval/i.test(t))
        .map((t) => t.slice(0, 500)),
    };
  }

  log('Step 3/4  Resolving player pages to real stream URLs …');

  if (CONFIG.PREFLIGHT && allPages.length) {
    const step = Math.max(1, Math.floor(allPages.length / 6));
    const sample = allPages.filter((_, i) => i % step === 0).slice(0, 6);
    log(`Self-test on ${sample.length} player pages …`);
    await Promise.all(sample.map((u) => resolveOne(u)));
    const ok = sample.filter((u) => resolved.get(u).media);
    sample.forEach((u) => { const r = resolved.get(u); log(`  ${r.media ? 'OK  ' : 'FAIL'} ${u}${r.media ? '\n       -> ' + r.media + ' [' + r.via + ']' : '  (' + r.error + ')'}`); });
    if (!ok.length && !CONFIG.FORCE) {
      const firstUrl = sample.find((u) => htmlSamples.has(u)) || sample[0];
      window.jagledamDebug = { url: firstUrl, html: htmlSamples.get(firstUrl) || '', summary: diagnose(firstUrl, htmlSamples.get(firstUrl)) };
      console.error('[JaGledam] Self-test: none of the sample player pages exposes a direct stream URL, so I stopped before the long run.');
      console.log('Page summary:', window.jagledamDebug.summary);
      console.log('Full page source is in  window.jagledamDebug.html  ->  run  copy(window.jagledamDebug.html)  and send it to Claude to adapt the resolver.');
      return;
    }
    log(`Self-test passed: ${ok.length}/${sample.length} resolved. Continuing with all pages …`);
  }

  // static pass
  const todo = allPages.filter((u) => !resolved.has(u));
  let doneRes = allPages.length - todo.length;
  await pool(todo, CONFIG.CONCURRENCY_RESOLVE, async (url) => {
    let r = await resolveStatic(url);
    if (r.html) htmlSamples.set(url, r.html);
    delete r.html;
    resolved.set(url, r);
    if (++doneRes % 25 === 0 || doneRes === allPages.length) log(`  ${doneRes}/${allPages.length} player pages (static)`);
    await sleep(CONFIG.DELAY_MS);
  });

  // runtime pass for whatever failed
  if (CONFIG.RUNTIME_SNIFF) {
    const failed = allPages.filter((u) => resolved.has(u) && !resolved.get(u).media && !sniffed.has(u));
    const sniffable = failed.filter((u) => { try { return new URL(u).origin === ORIGIN; } catch { return false; } });
    if (sniffable.length) {
      log(`Runtime fallback for ${sniffable.length} player pages (hidden iframes, ~${Math.ceil(sniffable.length / CONFIG.CONCURRENCY_SNIFF * CONFIG.SNIFF_TIMEOUT_MS / 60000)} min worst case) …`);
      let n = 0;
      await pool(sniffable, CONFIG.CONCURRENCY_SNIFF, async (url) => {
        const hit = await runtimeSniff(url);
        if (hit) resolved.set(url, { media: hit, referer: refererFor(url), via: 'runtime' });
        if (++n % 10 === 0 || n === sniffable.length) log(`  ${n}/${sniffable.length} sniffed`);
      });
    }
  }

  /* ───────────────── 4) BUILD THE M3U PLAYLIST ───────────────── */
  const attr = (s) => String(s || '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();
  const entries = [];
  const unresolved = [];

  for (const r of rows) {
    if (r.error) { unresolved.push({ channel: r.name, page: r.url, reason: r.error }); continue; }
    let linkNo = 0;
    for (const pageUrl of r.streams) {
      const res = resolved.get(pageUrl);
      if (!res || !res.media) {
        unresolved.push({ channel: r.name, page: r.url, player: pageUrl, reason: (res && res.error) || 'not resolved', embed: res && res.embed });
        continue;
      }
      if (!CONFIG.KEEP_ALL_LINKS && linkNo >= 1) break;
      linkNo++;
      entries.push({
        channel: r.name,
        title: CONFIG.MARK_ALT_LINKS && linkNo > 1 ? `${r.name} (Link ${linkNo})` : r.name,
        group: (CONFIG.GROUP_BY === 'country' ? r.country : r.category) || r.country || r.category || 'Undefined',
        logo: r.logo,
        country: r.country,
        media: res.media,
        referer: res.referer,
        player: pageUrl,
      });
    }
  }
  entries.sort((a, b) => a.group.localeCompare(b.group) || a.channel.localeCompare(b.channel) || a.title.localeCompare(b.title));

  const lines = ['#EXTM3U'];
  for (const e of entries) {
    lines.push(`#EXTINF:-1 tvg-id="" tvg-name="${attr(e.channel)}" tvg-logo="${attr(e.logo)}" group-title="${attr(e.group)}",${attr(e.title)}`);
    if (e.referer) lines.push(`#EXTVLCOPT:http-referrer=${e.referer}`);
    if (CONFIG.USER_AGENT) lines.push(`#EXTVLCOPT:http-user-agent=${CONFIG.USER_AGENT}`);
    lines.push(e.media);
  }
  const m3u = lines.join('\n') + '\n';

  // sanity check: the same media URL under many different channels is suspicious
  const usage = new Map();
  entries.forEach((e) => usage.set(e.media, (usage.get(e.media) || new Set()).add(e.channel)));
  const shared = [...usage].filter(([, s]) => s.size > 3);
  if (shared.length) warn('Same stream URL used by more than 3 channels (probably a wrong match):', shared.map(([u, s]) => `${u}  x${s.size}`));

  function download(filename, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  const date = new Date().toISOString().slice(0, 10);
  const plName = `${CONFIG.FILE_PREFIX}_${date}.m3u`;
  download(plName, m3u, 'audio/x-mpegurl');

  if (CONFIG.REPORT_FILE && unresolved.length) {
    const rep = [
      `JaGledam – player pages that could not be resolved (${unresolved.length})`,
      'Reason: no stream URL could be read from the page source or the hidden-iframe check (cross-origin embed, Twitch/YouTube embed, DRM or an obfuscated player).',
      '',
      ...unresolved.map((u) => `${u.channel}\n  channel page: ${u.page}\n  player page:  ${u.player || '-'}\n  embed:        ${u.embed || '-'}\n  reason:       ${u.reason}\n`),
    ].join('\n');
    setTimeout(() => download(`${CONFIG.FILE_PREFIX}_unresolved_${date}.txt`, rep, 'text/plain'), 1200);
  }

  const failedSamples = {};
  for (const [u, h] of htmlSamples) {
    if (resolved.get(u) && !resolved.get(u).media && Object.keys(failedSamples).length < 5) failedSamples[u] = h.slice(0, 30000);
  }
  window.jagledamFailedSamples = failedSamples;

  window.jagledamIptv = { entries, unresolved, channels: rows, resolved: Object.fromEntries(resolved) };
  const via = entries.reduce((o, e) => { const v = (resolved.get(e.player) || {}).via || '?'; o[v] = (o[v] || 0) + 1; return o; }, {});
  log(`Step 4/4  Done. Playlist "${plName}": ${entries.length} streams from ${new Set(entries.map((e) => e.channel)).size} channels.`);
  log('Resolved via:', via, '| unresolved player pages:', unresolved.length);
  log('Data: window.jagledamIptv');
  if (unresolved.length) log('Source of up to 5 unresolved player pages:  copy(JSON.stringify(window.jagledamFailedSamples))');
})();
