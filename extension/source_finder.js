(() => {
  const ns = window.Echo360Translator;
  const videoApi = ns.video;
  const vttApi = ns.vtt;
  const INSTRUCTURE_MEDIA_HOST_RE = /(^|\.)instructuremedia\.com$/i;
  const STATIC_ASSET_EXT_RE = /\.(?:avif|bmp|css|gif|html?|ico|jpe?g|js|json|map|mjs|mp4|m4s|mpd|png|svg|ts|ttf|wasm|webm|woff2?)(?:[?#]|$)/i;
  const TEXT_TRACK_HINT_RE = /(?:\.vtt|webvtt|subtitle|caption|transcript|media[_-]?track|text[_-]?track|timedtext)/i;

  function logUrl(value) {
    return ns.errorUtils?.redactUrl?.(value) || String(value || "");
  }

  function specificErrorCode(error, fallback = "RESOURCE_FETCH_FAILED") {
    const inferred = ns.errorUtils?.getErrorCode?.(error);
    return inferred && !ns.errorUtils?.isGenericCode?.(inferred) ? inferred : fallback;
  }

  function validStatus(value) {
    const status = Number(value);
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  }

  function isInstructureMediaResource(url) {
    try {
      const parsed = new URL(url);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        INSTRUCTURE_MEDIA_HOST_RE.test(parsed.hostname);
    } catch (_) {
      return false;
    }
  }

  // Content-script fetches still follow the page's CORS boundary. Instructure
  // normally allows the embed origin, but a signed caption URL can be served
  // from a different media subdomain with stricter headers. The service worker
  // fallback uses the declared Instructure host permission while keeping the
  // request target allowlisted; this avoids adding a broad arbitrary proxy.
  async function fetchTextResource(url) {
    let contentError = null;
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (resp.ok) return { ok: true, text: await resp.text(), via: "content" };
      contentError = new Error(`HTTP ${resp.status}`);
      contentError.code = `HTTP_${resp.status}`;
      contentError.status = resp.status;
    } catch (err) {
      contentError = err;
    }

    if (!isInstructureMediaResource(url) || !ns.browserApi?.runtime?.sendMessage) {
      return {
        ok: false,
        error: contentError?.message || String(contentError || "fetch failed"),
        code: specificErrorCode(contentError),
        status: validStatus(contentError?.status),
      };
    }
    try {
      const response = await ns.browserApi.runtime.sendMessage({
        type: "fetch-text-resource",
        url,
      });
      if (response?.ok && typeof response.data?.text === "string") {
        return { ok: true, text: response.data.text, via: "service-worker" };
      }
      return {
        ok: false,
        error: response?.error || "service-worker fetch failed",
        code: specificErrorCode(response, response?.error_code || "RESOURCE_FETCH_FAILED"),
        status: validStatus(response?.status),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: specificErrorCode(err), status: validStatus(err?.status) };
    }
  }

  function asArray(value) {
    if (!value) return [];
    try { return Array.from(value); } catch (_) { return []; }
  }

  function getPlayerForVideo(video) {
    return ns.hostSupport?.getPlayer?.(video) ||
      video?.closest?.("[data-media-player]") ||
      document.querySelector("[data-media-player]");
  }

  function readTrackValue(track, key) {
    try {
      const value = track?.[key];
      return typeof value === "string" ? value.trim() : "";
    } catch (_) {
      return "";
    }
  }

  function collectTextTrackObjects(video) {
    const player = getPlayerForVideo(video);
    const lists = [
      video?.textTracks,
      player?.textTracks,
      player?.media?.textTracks,
      player?.provider?.textTracks,
      player?.state?.textTracks,
      player?.$state?.textTracks?.value,
    ];
    const tracks = [];
    const seen = new Set();
    for (const list of lists) {
      for (const track of asArray(list)) {
        if (!track || seen.has(track)) continue;
        seen.add(track);
        tracks.push(track);
      }
    }
    return tracks;
  }

  function collectTrackSourceUrls(video) {
    const urls = [];
    const seen = new Set();
    const add = (raw) => {
      const value = String(raw || "").trim();
      if (!value || value.startsWith("blob:") || value.startsWith("data:")) return;
      try {
        const url = new URL(value, location.href).toString();
        if (!/^https?:/i.test(url) || seen.has(url)) return;
        seen.add(url);
        urls.push(url);
      } catch (_) {}
    };

    const player = getPlayerForVideo(video);
    const trackEls = [
      ...asArray(video?.querySelectorAll?.("track")),
      ...asArray(player?.querySelectorAll?.("track")),
    ];
    for (const track of trackEls) {
      add(track.getAttribute?.("src"));
      add(track.src);
      add(track.getAttribute?.("data-src"));
    }
    for (const track of collectTextTrackObjects(video)) {
      add(readTrackValue(track, "src"));
      add(readTrackValue(track, "url"));
      add(readTrackValue(track, "srcUrl"));
      add(readTrackValue(track?.source, "src"));
      add(readTrackValue(track?.source, "url"));
      add(readTrackValue(track?.element, "src"));
    }
    return urls;
  }

  function buildVttFromCues(track) {
    const cues = asArray(track?.cues);
    if (cues.length === 0) return "";
    const lines = ["WEBVTT", ""];
    cues.forEach((cue, index) => {
      const text = vttApi.cueTextToLine(cue?.text);
      if (!text) return;
      lines.push(String(index + 1));
      lines.push(`${vttApi.formatVttTime(Number(cue.startTime || 0))} --> ${vttApi.formatVttTime(Number(cue.endTime || 0))}`);
      lines.push(text);
      lines.push("");
    });
    return lines.length > 2 ? lines.join("\n") : "";
  }

  function findBestTrackElement(video) {
    const hasUsableSrc = (track) => !!String(track?.getAttribute?.("src") || "").trim();
    const tracks = Array.from(video.querySelectorAll("track")).filter(hasUsableSrc);
    if (tracks.length > 0) return tracks[0];
    const textTracks = Array.from(document.querySelectorAll("track")).filter(hasUsableSrc);
    return textTracks[0] || null;
  }

  // Echo360's own CC box is rendered through a custom DOM overlay, not the
  // HTML5 <track>/TextTrack API — video.textTracks stays empty even on
  // lessons that visibly have a working CC toggle. So the only reliable,
  // toggle-state-independent signal is the *existence* of the player's own
  // "Toggle Captions" control: its aria-label/title stay in English
  // regardless of the page's UI language, while its generated class names
  // (styled-components hashes) are not stable across Echo360 deployments.
  function findCaptionToggleButton(video) {
    const player = video?.closest?.("#player") || document.querySelector("#player") || document;
    const controls = Array.from(player.querySelectorAll('button, [role="button"]'));
    return controls.find((el) => {
      const hint = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
      return /caption|subtitle/i.test(hint);
    }) || null;
  }

  // Whether this video has ANY Echo360-owned caption capability at all —
  // regardless of whether it is currently toggled on/off. Deliberately
  // independent of "is a caption box visible right now":
  //   - A <track>/TextTrack existing (any `mode`), or the player exposing a
  //     "Toggle Captions" control (any `aria-pressed` state), means the
  //     lesson genuinely has native CC; if nothing is visible, that's the
  //     user (or Echo360) having turned it off, not a missing feature.
  //   - Neither exists (our own translated-track elements are excluded) —
  //     e.g. a Transcript-only lesson with no synced CC — so DOM injection
  //     can never succeed no matter how long we wait.
  function hasNativeCaptionCapability(video) {
    if (!video) return false;
    const nativeTrackEls = Array.from(video.querySelectorAll("track[src]")).filter(
      (t) => !!String(t.getAttribute("src") || "").trim() && !t.hasAttribute("data-echo360-translated")
    );
    if (nativeTrackEls.length > 0) return true;
    if (Array.from(video.textTracks || []).some((t) => !(t.label || "").includes("翻译"))) return true;
    return !!findCaptionToggleButton(video);
  }

  async function exportVttFromTextTracks(video, timeoutMs = 8000) {
    const tracks = collectTextTrackObjects(video);
    if (tracks.length === 0) return "";
    const hasTrackSource = collectTrackSourceUrls(video).length > 0;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const t of tracks) {
        const vtt = buildVttFromCues(t);
        if (vtt) return vtt;
        // Vidstack/Instructure may expose an empty native TextTrack mirror
        // while its actual caption source is managed by the custom player.
        // Do not set that empty track to hidden: the browser would try to
        // load the empty `src` attribute as a page URL. Real source-backed
        // tracks retain the old hidden-mode loading behavior.
        if (hasTrackSource && t.mode === "disabled") t.mode = "hidden";
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return "";
  }

  function isLikelySubtitleResource(url) {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/i.test(parsed.protocol)) return false;
      // Do not mistake the player's Captions*.js/CaptionEditor*.js chunks or
      // other static assets for subtitle files merely because their filename
      // contains the word "caption".
      if (STATIC_ASSET_EXT_RE.test(parsed.pathname)) return false;
      return TEXT_TRACK_HINT_RE.test(`${parsed.pathname}${parsed.search}`);
    } catch (_) {
      return false;
    }
  }

  function collectCandidateSubtitleUrls(video = null) {
    const entries = performance.getEntriesByType("resource") || [];
    const items = [];
    for (const e of entries) {
      const name = String(e.name || "");
      if (isLikelySubtitleResource(name)) {
        items.push({ url: name, responseEnd: Number(e.responseEnd || 0) });
      }
    }
    for (const url of collectTrackSourceUrls(video)) {
      let isNonStaticResource = false;
      try {
        isNonStaticResource = !STATIC_ASSET_EXT_RE.test(new URL(url).pathname);
      } catch (_) {
        isNonStaticResource = false;
      }
      if (isLikelySubtitleResource(url) || isNonStaticResource) {
        items.push({ url, responseEnd: Number.MAX_SAFE_INTEGER });
      }
    }
    const dedup = new Map();
    for (const item of items) dedup.set(item.url, item);
    return Array.from(dedup.values()).sort((a, b) => b.responseEnd - a.responseEnd).slice(0, 20);
  }

  function hasUsableCueText(text) {
    const cues = vttApi.parseVttCues?.(text);
    // parseVttCues is the same parser used by the renderer. If it is not
    // available in a legacy build, keep the older cue-count fallback and let
    // the final source validator make the definitive decision.
    return Array.isArray(cues)
      ? cues.length > 0 && cues.every((cue) => String(cue?.text || "").trim())
      : true;
  }

  function getLessonId() {
    const m = String(location.pathname || "").match(/\/lesson\/([^/]+)/);
    return m ? m[1] : "";
  }

  function collectTranscriptMediaIdCandidates() {
    const lessonId = getLessonId();
    const lessonLower = lessonId.toLowerCase();
    const resourceIds = [...videoApi.collectInteractiveMediaIdsFromResources()];
    const hintIds = [];
    const seen = new Set(resourceIds);
    for (const v of videoApi.getAllVideos()) {
      for (const id of videoApi.getVideoHintMediaIds(v)) {
        if (seen.has(id)) continue;
        // React fiber / lesson URLs often leak partial UUIDs from the lesson id
        // itself (e.g. 2f659ee3… from G_2f659ee3-…_927f0a6a-…). They never
        // resolve to a transcript-file endpoint and only add console noise.
        if (lessonLower.includes(String(id).toLowerCase())) continue;
        seen.add(id);
        hintIds.push(id);
      }
    }
    return { lessonId, resourceIds, hintIds };
  }

  async function tryTranscriptFileForMediaIds(lessonId, mediaIds, video) {
    if (mediaIds.length === 0) return { best: null, attempts: [] };
    const nowSec = Number(video?.currentTime || 0);
    let best = null;
    const attempts = [];
    for (const mediaId of mediaIds) {
      const url = `${location.origin}/api/ui/echoplayer/lessons/${encodeURIComponent(lessonId)}/medias/${encodeURIComponent(mediaId)}/transcript-file?format=vtt`;
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) {
          attempts.push({ strategy: "transcript-file", mediaId, url, outcome: "fetch-failed", code: `HTTP_${resp.status}`, status: resp.status, error: `HTTP ${resp.status}` });
          continue;
        }
        const rawText = await resp.text();
        const text = vttApi.normalizeTimedText
          ? vttApi.normalizeTimedText(rawText)
          : rawText;
        if (!text) {
          attempts.push({ strategy: "transcript-file", mediaId, url, outcome: "empty", code: "EMPTY_VTT", error: "empty response" });
          continue;
        }
        const stats = vttApi.parseVttStats(text);
        if (stats.cueCount <= 0) {
          attempts.push({ strategy: "transcript-file", mediaId, url, outcome: "no-cues", code: "EMPTY_VTT", error: "zero cues" });
          continue;
        }
        if (!hasUsableCueText(text)) {
          attempts.push({ strategy: "transcript-file", mediaId, url, outcome: "empty-or-invalid", code: "INVALID_SOURCE_VTT", cueCount: stats.cueCount, error: "one or more timed cues have no caption text" });
          continue;
        }
        const coversNow = stats.ranges.some(([s, e]) => nowSec >= s && nowSec <= e);
        const score = (coversNow ? 1_000_000 : 0) + stats.maxEnd * 100 + stats.cueCount;
        if (!best || score > best.score) {
          best = { score, text, url, mediaId, cueCount: stats.cueCount, coversNow };
        }
        attempts.push({ strategy: "transcript-file", mediaId, url, outcome: "usable", code: "OK", cueCount: stats.cueCount });
      } catch (error) {
        attempts.push({ strategy: "transcript-file", mediaId, url, outcome: "exception", code: specificErrorCode(error, "RESOURCE_NETWORK_ERROR"), status: validStatus(error?.status), error: error?.message || String(error) });
      }
    }
    return { best, attempts };
  }

  function buildTranscriptFileResult(best) {
    return {
      text: best.text,
      sourceId: best.url,
      strongMapped: true,
      sourceMeta: {
        sourceId: best.url,
        mediaId: best.mediaId,
        mapSource: "transcript-file",
        strongMapped: true,
        stats: vttApi.parseVttStats(best.text),
      },
    };
  }

  // Echo360's transcript side panel (search icon + speaker labels, e.g. when
  // the player itself shows no CC track) is backed by a stable, documented
  // API — the same one its own "Download" button uses — rather than a
  // network request whose URL contains "vtt"/"caption"/"subtitle". Hitting
  // it directly finds a real, cue-timed VTT even when collectCandidateSubtitleUrls()
  // and the <track>/TextTrack based lookups all come up empty.
  async function fetchTranscriptFileVtt(video) {
    const empty = { text: "", sourceId: "", strongMapped: false, sourceMeta: null, diagnostics: { candidateCount: 0, attempts: [] } };
    const { lessonId, resourceIds, hintIds } = collectTranscriptMediaIdCandidates();
    if (!lessonId || (resourceIds.length === 0 && hintIds.length === 0)) return empty;

    // Interactive-media resource ids map directly to this lesson's transcript.
    // When one of them hits, stop immediately — do not keep probing React-fiber
    // hint UUIDs that mostly 404 and clutter the console.
    let probe = await tryTranscriptFileForMediaIds(lessonId, resourceIds, video);
    let best = probe.best;
    const diagnostics = { candidateCount: resourceIds.length + hintIds.length, attempts: [...probe.attempts] };
    if (best) {
      console.log(
        "[echo360-translator] using Echo360 transcript-file API VTT:",
        logUrl(best.url),
        "cues=",
        best.cueCount,
        "coversNow=",
        best.coversNow
      );
      return { ...buildTranscriptFileResult(best), diagnostics };
    }

    probe = await tryTranscriptFileForMediaIds(lessonId, hintIds, video);
    best = probe.best;
    diagnostics.attempts.push(...probe.attempts);
    if (!best) return { ...empty, diagnostics: { ...diagnostics, attempts: diagnostics.attempts.slice(0, 30) } };

    console.log(
      "[echo360-translator] using Echo360 transcript-file API VTT:",
      logUrl(best.url),
      "cues=",
      best.cueCount,
      "coversNow=",
      best.coversNow
    );
    return { ...buildTranscriptFileResult(best), diagnostics: { ...diagnostics, attempts: diagnostics.attempts.slice(0, 30) } };
  }

  function buildSourceMeta(sourceId, vttText) {
    const mediaId = videoApi.extractMediaIdFromVttUrl(sourceId || "");
    return {
      sourceId: sourceId || "",
      mediaId,
      mapSource: "",
      // Merely having a UUID in a caption URL does not prove that it belongs
      // to the active video. Callers set this flag only after an explicit
      // transcript-file/video/resource mapping.
      strongMapped: false,
      stats: vttApi.parseVttStats(vttText),
    };
  }

  // Resource Timing often exposes Instructure's caption_files request with a
  // numeric cache-buster, for example `?1787725908057`.  That value changes on
  // every player load but does not identify a different subtitle track.  Use a
  // stable source key for the translation cache while retaining the original
  // URL in sourceMeta/sourceId for fetching and diagnostics.
  function canonicalizeSourceId(sourceId) {
    const raw = String(sourceId || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw, location.href);
      if (INSTRUCTURE_MEDIA_HOST_RE.test(url.hostname) &&
        /\/api\/media_management\/caption_files\//i.test(url.pathname)) {
        const params = Array.from(url.searchParams.entries());
        const isCacheBuster = params.length > 0 && params.every(([key, value]) =>
          /^(?:_|ts|t|time|timestamp|cache|cachebust|cache_bust|cb)$/i.test(key) ||
          /^\d{8,}$/.test(key) ||
          /^\d{8,}$/.test(value)
        );
        if (isCacheBuster) url.search = "";
      }
      return url.toString();
    } catch (_) {
      return raw;
    }
  }

  async function fetchBestVttFromCandidates(video) {
    const candidates = collectCandidateSubtitleUrls(video);
    const diagnostics = [];
    const nowSec = Number(video?.currentTime || 0);
    const durationSec = Number(video?.duration || 0);
    const videoHintIds = videoApi.getVideoHintMediaIds(video);
    const resourceMediaIds = videoApi.collectInteractiveMediaIdsFromResources();
    const activeVideoBoost = videoApi.isVideoLikelyActive(video) ? 50_000 : 0;
    let best = null;
    for (const item of candidates) {
      try {
        const fetched = await fetchTextResource(item.url);
        if (!fetched.ok) {
          diagnostics.push({ url: item.url, outcome: "fetch-failed", code: fetched.code || "RESOURCE_FETCH_FAILED", status: fetched.status || null, error: fetched.error || "fetch failed" });
          continue;
        }
        const text = vttApi.normalizeTimedText
          ? vttApi.normalizeTimedText(fetched.text)
          : fetched.text;
        if (!text) {
          diagnostics.push({ url: item.url, outcome: "empty-or-invalid", code: "EMPTY_VTT", status: null, error: "empty or unparseable timed text" });
          continue;
        }
        const stats = vttApi.parseVttStats(text);
        if (stats.cueCount <= 0) {
          diagnostics.push({ url: item.url, outcome: "no-cues", code: "EMPTY_VTT", status: null, error: "zero cues" });
          continue;
        }
        if (!hasUsableCueText(text)) {
          diagnostics.push({ url: item.url, outcome: "empty-or-invalid", code: "INVALID_SOURCE_VTT", status: null, cueCount: stats.cueCount, error: "one or more timed cues have no caption text" });
          continue;
        }
        const coversNow = stats.ranges.some(([s, e]) => nowSec >= s && nowSec <= e);
        const mediaId = videoApi.extractMediaIdFromVttUrl(item.url);
        const videoMapped = mediaId && videoHintIds.has(mediaId);
        const resourceMapped = mediaId && resourceMediaIds.has(mediaId);
        const strongMapped = !!(videoMapped || resourceMapped);
        const mapSource = videoMapped ? "video" : resourceMapped ? "resource" : "";

        let durationScore = 0;
        if (Number.isFinite(durationSec) && durationSec > 0 && Number.isFinite(stats.maxEnd) && stats.maxEnd > 0) {
          const diff = Math.abs(durationSec - stats.maxEnd);
          durationScore = Math.max(0, 20_000 - diff * 200);
        }

        const score =
          (strongMapped ? 10_000_000 : 0) +
          (coversNow ? 1_000_000 : 0) +
          durationScore +
          activeVideoBoost +
          stats.maxEnd * 100 +
          stats.cueCount +
          item.responseEnd / 1000;
        if (!best || score > best.score) {
          best = {
            score,
            text,
            url: item.url,
            mediaId,
            cueCount: stats.cueCount,
            strongMapped,
            mapSource,
            coversNow,
            durationScore: Math.round(durationScore),
          };
        }
      } catch (error) {
        diagnostics.push({
          url: item.url,
          outcome: "exception",
          code: specificErrorCode(error),
          status: validStatus(error?.status),
          error: error?.message || String(error),
        });
      }
    }
    if (!best) return {
      text: "",
      sourceId: "",
      strongMapped: false,
      sourceMeta: null,
      diagnostics: { candidateCount: candidates.length, attempts: diagnostics.slice(0, 20) },
    };
    const stats = vttApi.parseVttStats(best.text);
    if (best.strongMapped) {
      console.log(
        "[echo360-translator] using strong-mapped VTT candidate:",
        logUrl(best.url),
        "match=",
        best.mapSource,
        "cues=",
        best.cueCount,
        "maxEnd=",
        Math.round(stats.maxEnd),
        "coversNow=",
        best.coversNow,
        "durationScore=",
        best.durationScore
      );
    } else {
      console.log(
        "[echo360-translator] using timeline+state fallback VTT candidate:",
        logUrl(best.url),
        "cues=",
        best.cueCount,
        "maxEnd=",
        Math.round(stats.maxEnd),
        "coversNow=",
        best.coversNow,
        "durationScore=",
        best.durationScore
      );
    }
    return {
      text: best.text,
      sourceId: best.url,
      strongMapped: !!best.strongMapped,
      sourceMeta: {
        ...buildSourceMeta(best.url, best.text),
        mapSource: best.mapSource || "",
        strongMapped: !!best.strongMapped,
        diagnostics: { candidateCount: candidates.length, attempts: diagnostics.slice(0, 20) },
      },
      diagnostics: { candidateCount: candidates.length, attempts: diagnostics.slice(0, 20) },
    };
  }

  function pickBestMountVideoByVtt(vttText, sourceMeta = null) {
    const videos = videoApi.getAllVideos();
    if (videos.length === 0) return null;
    if (!vttText) return videoApi.getPrimaryVideo();
    const stats = sourceMeta?.stats || vttApi.parseVttStats(vttText);
    const vttEnd = Number(stats.maxEnd || 0);
    if (!(vttEnd > 0)) return videoApi.getPrimaryVideo();
    const mediaId = (sourceMeta?.mediaId || "").toLowerCase();

    let best = null;
    for (const v of videos) {
      const d = Number(v.duration || 0);
      if (!Number.isFinite(d) || d <= 0) continue;
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
      const diff = Math.abs(d - vttEnd);
      const canContainTimeline = d + 2 >= vttEnd;
      const strongMapped = mediaId && videoApi.getVideoHintMediaIds(v).has(mediaId);
      const coversCurrent = stats.ranges.some(([s, e]) => Number(v.currentTime || 0) >= s && Number(v.currentTime || 0) <= e);
      const closeDurationScore = Math.max(0, 2_000_000 - diff * 2000);
      const timelineScore = canContainTimeline ? 5_000_000 : -5_000_000;
      const score =
        (strongMapped ? 20_000_000 : 0) +
        timelineScore +
        closeDurationScore +
        (coversCurrent ? 1_000_000 : 0) +
        (!v.paused && !v.ended ? 100_000 : 0) +
        (Number(v.currentTime || 0) > 0 ? 50_000 : 0) +
        (visible ? 20_000 : 0) +
        area / 1000;
      if (!best || score > best.score) best = { video: v, score };
    }
    if (best?.video) {
      const d = Number(best.video.duration || 0);
      if (d + 2 < vttEnd && videos.length > 1 && vttEnd > 60) return null;
    }
    return best?.video || videoApi.getPrimaryVideo();
  }

  ns.sourceFinder = {
    findBestTrackElement,
    hasNativeCaptionCapability,
    exportVttFromTextTracks,
    collectCandidateSubtitleUrls,
    buildSourceMeta,
    canonicalizeSourceId,
    fetchTranscriptFileVtt,
    fetchTextResource,
    fetchBestVttFromCandidates,
    pickBestMountVideoByVtt,
    collectTextTrackObjects,
    collectTrackSourceUrls,
    hasUsableCueText,
  };
})();
