(() => {
  const ns = window.Echo360Translator;

  const DEFAULT_PENDING_LABEL = ns.constants?.SUBTITLE_PENDING_LABEL || "正在翻译中...";
  const DEFAULT_FAILURE_LABEL = ns.constants?.SUBTITLE_FAILURE_LABEL || "[翻译失败]";
  const TIME_TOLERANCE_MS = 250;

  function normalizeSearchText(value) {
    let text = String(value == null ? "" : value);
    try {
      text = text.normalize("NFKC");
    } catch (_) {}
    // VTT may contain voice/class/time tags.  They are presentation metadata,
    // not part of the searchable transcript wording.
    text = text
      .replace(/<\/?(?:v|c|lang|ruby|rt|b|i|u)(?:\s[^>]*)?>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/[\u00a0\u2007\u202f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    try {
      return text.toLocaleLowerCase();
    } catch (_) {
      return text.toLowerCase();
    }
  }

  function plainCueText(value) {
    return String(value == null ? "" : value)
      .replace(/\r/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();
  }

  function parseCues(vttText) {
    if (!vttText) return [];
    if (ns.vtt?.parseVttCues) return ns.vtt.parseVttCues(vttText);
    return [];
  }

  function cueKey(cue, index = cue?.index || 0) {
    return `${Math.round(Number(cue?.startMs || 0))}:${Math.round(Number(cue?.endMs || 0))}:${index}`;
  }

  function intervalOverlapRatio(a, b) {
    const start = Math.max(a.startMs, b.startMs);
    const end = Math.min(a.endMs, b.endMs);
    const overlap = Math.max(0, end - start);
    const shorter = Math.max(1, Math.min(a.endMs - a.startMs, b.endMs - b.startMs));
    return overlap / shorter;
  }

  function timeClose(a, b) {
    return Math.abs(Number(a.startMs) - Number(b.startMs)) <= TIME_TOLERANCE_MS &&
      Math.abs(Number(a.endMs) - Number(b.endMs)) <= TIME_TOLERANCE_MS;
  }

  function isFailureText(text, failureLabel = DEFAULT_FAILURE_LABEL) {
    const normalized = normalizeSearchText(text);
    return normalized === normalizeSearchText(failureLabel) || normalized.includes("[翻译失败]");
  }

  function isPendingText(text, originalText, pendingLabel = DEFAULT_PENDING_LABEL) {
    const normalized = normalizeSearchText(text);
    if (!normalized) return true;
    if (normalized === normalizeSearchText(pendingLabel)) return true;
    return !!originalText && normalized === normalizeSearchText(originalText);
  }

  // A translated VTT can occasionally be returned in the already-bilingual
  // format used by the browser renderer.  Keep the target line while retaining
  // ordinary multi-line target translations unchanged.
  function translatedTextForCue(translatedCue, originalCue) {
    const raw = plainCueText(translatedCue?.text);
    if (!raw || !originalCue) return raw;
    const original = normalizeSearchText(originalCue.text);
    if (!original || !normalizeSearchText(raw).includes(original)) return raw;
    const parts = raw.split("\n").map((part) => part.trim()).filter(Boolean);
    const nonOriginal = parts.filter((part) => !normalizeSearchText(part).includes(original));
    if (nonOriginal.length > 0) return nonOriginal.join("\n");
    // A target containing the same words as the source is still a valid
    // translation; returning the raw text lets the pending check decide.
    return raw;
  }

  function alignTranslationCues(originalCues, translatedCues) {
    const mapping = new Map();
    const used = new Set();
    if (originalCues.length === 0 || translatedCues.length === 0) return mapping;

    const sameShape = originalCues.length === translatedCues.length &&
      originalCues.every((cue, index) => timeClose(cue, translatedCues[index]));
    if (sameShape) {
      originalCues.forEach((cue, index) => {
        mapping.set(index, translatedCues[index]);
        used.add(index);
      });
      return mapping;
    }

    // Resolve only globally unique candidate pairs.  A greedy pass could
    // consume one translated cue for the first of two equally plausible
    // source cues and silently mis-map the second; ambiguity must remain
    // unmapped until a later flush has a stronger anchor.
    const remainingOriginals = new Set(originalCues.map((_, index) => index));
    const remainingTranslations = new Set(translatedCues.map((_, index) => index));
    while (remainingOriginals.size > 0 && remainingTranslations.size > 0) {
      const candidatesByOriginal = new Map();
      const ownersByTranslation = new Map();
      for (const oi of remainingOriginals) {
        const original = originalCues[oi];
        const candidates = [...remainingTranslations].filter((ti) => {
          const translated = translatedCues[ti];
          if (Math.abs(original.startMs - translated.startMs) > TIME_TOLERANCE_MS) return false;
          return intervalOverlapRatio(original, translated) >= 0.5;
        });
        candidatesByOriginal.set(oi, candidates);
        for (const ti of candidates) {
          const owners = ownersByTranslation.get(ti) || [];
          owners.push(oi);
          ownersByTranslation.set(ti, owners);
        }
      }
      const assignments = [];
      for (const [oi, candidates] of candidatesByOriginal.entries()) {
        if (candidates.length !== 1) continue;
        const ti = candidates[0];
        if ((ownersByTranslation.get(ti) || []).length === 1) assignments.push([oi, ti]);
      }
      if (assignments.length === 0) break;
      for (const [oi, ti] of assignments) {
        mapping.set(oi, translatedCues[ti]);
        used.add(ti);
        remainingOriginals.delete(oi);
        remainingTranslations.delete(ti);
      }
    }
    return mapping;
  }

  function buildSearchIndex(cues) {
    const original = new Map();
    const translation = new Map();
    for (const cue of cues) {
      if (cue.normalizedOriginal) {
        const values = original.get(cue.normalizedOriginal) || [];
        values.push(cue);
        original.set(cue.normalizedOriginal, values);
      }
      if (cue.status !== "unmapped" && cue.normalizedTranslation) {
        const values = translation.get(cue.normalizedTranslation) || [];
        values.push(cue);
        translation.set(cue.normalizedTranslation, values);
      }
    }
    return { original, translation };
  }

  function makeSessionKey({ sessionKey, sourceMeta, target }) {
    if (sessionKey) return String(sessionKey);
    const source = sourceMeta?.sourceKey || sourceMeta?.sourceId || sourceMeta?.mediaId || "page";
    const config = sourceMeta?.configSig || "";
    return `${source}::${config || String(target || "ZH").toUpperCase()}`;
  }

  function buildTranscriptModel(input = {}, maybeTranslatedVtt, maybeOptions = {}, maybeTarget) {
    // Support both the documented object form and the convenient positional
    // form used by small integrations/tests.
    const options = typeof input === "string"
      ? {
        originalVtt: input,
        translatedVtt: maybeTranslatedVtt,
        ...(maybeOptions || {}),
        target: maybeTarget || maybeOptions?.target,
      }
      : (input || {});
    if (typeof input === "string" && maybeOptions && !maybeOptions.sourceMeta &&
        (maybeOptions.sourceId || maybeOptions.mediaId || maybeOptions.mapSource || maybeOptions.stats)) {
      options.sourceMeta = maybeOptions;
    }
    const originalVtt = String(options.originalVtt || options.original || "");
    const translatedVtt = String(options.translatedVtt || options.translated || "");
    const target = String(options.target || "ZH").toUpperCase();
    const pendingLabel = options.pendingLabel || DEFAULT_PENDING_LABEL;
    const failureLabel = options.failureLabel || DEFAULT_FAILURE_LABEL;
    const failurePreview = options.failurePreview === true;
    const originalCues = parseCues(originalVtt);
    const translatedCues = parseCues(translatedVtt);
    const mapping = alignTranslationCues(originalCues, translatedCues);
    const cues = originalCues.map((original, index) => {
      const translatedCue = mapping.get(index) || null;
      const originalText = plainCueText(original.text);
      const translatedText = translatedCue
        ? translatedTextForCue(translatedCue, original)
        : "";
      let status = "unmapped";
      if (translatedCue) {
        status = isFailureText(translatedText || translatedCue.text, failureLabel)
          ? "failed"
          : isPendingText(translatedText, originalText, pendingLabel)
            ? (failurePreview ? "failed" : "pending")
            : "ready";
      }
      const displayText = status === "failed"
        ? failureLabel
        : status === "pending"
          ? pendingLabel
          : translatedText;
      return {
        key: cueKey(original, index),
        index,
        startMs: Number(original.startMs),
        endMs: Number(original.endMs),
        originalText,
        translatedText: displayText,
        normalizedOriginal: normalizeSearchText(originalText),
        normalizedTranslation: normalizeSearchText(displayText),
        status,
        translatedIndex: translatedCue ? translatedCue.index : null,
      };
    });
    const model = {
      sessionKey: makeSessionKey({ sessionKey: options.sessionKey, sourceMeta: options.sourceMeta, target }),
      sourceMeta: options.sourceMeta || {},
      source: options.sourceMeta || {},
      target,
      pendingLabel,
      failureLabel,
      cues,
      searchIndex: buildSearchIndex(cues),
      stats: {
        originalCueCount: originalCues.length,
        translatedCueCount: translatedCues.length,
        mappedCueCount: cues.filter((cue) => cue.status !== "unmapped").length,
        unmappedCueCount: cues.filter((cue) => cue.status === "unmapped").length,
      },
    };
    return model;
  }

  function normalizedWithMap(value) {
    const raw = String(value == null ? "" : value);
    let normalized = "";
    const map = [];
    let previousWasSpace = false;
    for (let index = 0; index < raw.length;) {
      const codePoint = raw.codePointAt(index);
      const width = codePoint > 0xffff ? 2 : 1;
      const originalPart = raw.slice(index, index + width);
      let part = originalPart;
      try { part = part.normalize("NFKC"); } catch (_) {}
      try { part = part.toLocaleLowerCase(); } catch (_) { part = part.toLowerCase(); }
      if (/\s/.test(part) || /[\u00a0\u2007\u202f]/.test(part)) {
        if (!previousWasSpace && normalized) {
          normalized += " ";
          map.push([index, index + width]);
        }
        previousWasSpace = true;
      } else {
        previousWasSpace = false;
        for (let offset = 0; offset < part.length; offset += 1) {
          normalized += part[offset];
          map.push([index, index + width]);
        }
      }
      index += width;
    }
    if (normalized.endsWith(" ")) {
      normalized = normalized.slice(0, -1);
      map.pop();
    }
    return { text: normalized, map };
  }

  function findOccurrences(text, query) {
    const sourceInfo = normalizedWithMap(text);
    const source = sourceInfo.text;
    const needle = normalizeSearchText(query);
    if (!source || !needle) return [];
    const ranges = [];
    let from = 0;
    while (from <= source.length - needle.length) {
      const index = source.indexOf(needle, from);
      if (index < 0) break;
      const startMap = sourceInfo.map[index];
      const endMap = sourceInfo.map[index + needle.length - 1];
      ranges.push({
        start: startMap ? startMap[0] : index,
        end: endMap ? endMap[1] : index + needle.length,
      });
      from = index + Math.max(1, needle.length);
    }
    return ranges;
  }

  function searchTranslations(model, query, visibleRowCount = null) {
    const matches = [];
    const text = String(query || "");
    if (!model?.cues || !normalizeSearchText(text)) return matches;
    const limit = visibleRowCount == null ? model.cues.length : Number(visibleRowCount);
    if (!Number.isInteger(limit) || limit < 0) return matches;
    for (const cue of model.cues.slice(0, Math.min(model.cues.length, limit))) {
      if (!cue.translatedText || cue.status === "unmapped") continue;
      const ranges = findOccurrences(cue.translatedText, text);
      for (const range of ranges) matches.push({ cue, ...range });
    }
    return matches;
  }

  function getCueByKey(model, key) {
    return model?.cues?.find((cue) => cue.key === key) || null;
  }

  ns.transcriptModel = {
    TIME_TOLERANCE_MS,
    normalizeSearchText,
    normalizeCueText: normalizeSearchText,
    parseCues,
    cueKey,
    intervalOverlapRatio,
    alignTranslationCues,
    buildSearchIndex,
    buildTranscriptModel,
    createModel: buildTranscriptModel,
    findOccurrences,
    normalizedWithMap,
    searchTranslations,
    findTranslationMatches: searchTranslations,
    getCueByKey,
    alignCues: alignTranslationCues,
    createTranscriptModel: buildTranscriptModel,
    searchTranslatedCues: searchTranslations,
  };
})();
