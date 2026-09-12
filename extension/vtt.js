(() => {
  const ns = window.Echo360Translator;
  const {
    DEFAULT_SUBTITLE_SIZE,
    CUE_LINE_MAP,
    SUBTITLE_PENDING_LABEL,
    SUBTITLE_FAILURE_LABEL,
  } = ns.constants;

  function formatVttTime(seconds) {
    const ms = Math.max(0, Math.floor(seconds * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mm = ms % 1000;
    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(mm)}`;
  }

  function cueTextToLine(text) {
    return String(text || "").replace(/\r/g, "").trim();
  }

  // Instructure Media's caption_files endpoint currently returns plain-text
  // SRT (for example, 00:00:01,234 --> 00:00:02,345), while the rest of the
  // extension expects WebVTT.  Normalize both formats at the source boundary
  // so translation, matching, and the custom player renderer all receive one
  // stable format.
  function normalizeTimedText(text) {
    const raw = String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .trim();
    if (!raw || !raw.includes("-->")) return "";

    const lines = raw.split("\n").map((line) => line.replace(
      /(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
      "$1.$2"
    ));
    if (/^WEBVTT(?:\s|$)/i.test(lines[0].trim())) return lines.join("\n");
    return ["WEBVTT", "", ...lines].join("\n");
  }

  function parseVttStats(vttText) {
    const lines = String(vttText || "").split("\n");
    let cueCount = 0;
    let maxEnd = 0;
    const ranges = [];
    for (const line of lines) {
      // WebVTT permits both MM:SS.mmm and HH:MM:SS.mmm timestamps. Reuse the
      // strict timing parser so source discovery and rendering count the same
      // cues regardless of which legal form the site emits.
      const timing = parseVttTimingLine(line);
      if (!timing) continue;
      cueCount += 1;
      const s = timing.startMs / 1000;
      const e = timing.endMs / 1000;
      if (e > maxEnd) maxEnd = e;
      ranges.push([s, e]);
    }
    // Keep the source identity useful for diagnostics as well as ranking. A
    // clean Echo360 source normally has one text line per cue; a rendered
    // bilingual/accumulated track has two or more. These counters are
    // observational only and do not change the line-based translation model.
    const cues = parseVttCues(vttText);
    const textLineCounts = cues.map((cue) => String(cue.text || "")
      .split("\n")
      .filter((line) => line.trim()).length);
    return {
      cueCount,
      maxEnd,
      ranges,
      textLineCount: textLineCounts.reduce((sum, count) => sum + count, 0),
      multilineCueCount: textLineCounts.filter((count) => count > 1).length,
      emptyCueCount: textLineCounts.filter((count) => count === 0).length,
    };
  }

  function parseVttBlocks(vttText) {
    const lines = String(vttText || "").replace(/\r/g, "").split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes("-->")) continue;
      let j = i + 1;
      const text = [];
      while (j < lines.length && lines[j].trim() !== "") {
        text.push(lines[j]);
        j += 1;
      }
      out.push({ time: lines[i], text: text.join("\n") });
      i = j;
    }
    return out;
  }

  // Parse a WebVTT timestamp into integer milliseconds.  Echo360's transcript
  // endpoint currently emits HH:MM:SS.mmm, but accepting the shorter MM:SS
  // form keeps the transcript model useful for ordinary VTT fixtures too.
  function parseVttTimestamp(value) {
    const text = String(value || "").trim();
    const parts = text.split(":");
    if (parts.length !== 2 && parts.length !== 3) return null;
    const secondsPart = parts[parts.length - 1];
    const sec = Number(secondsPart);
    const minute = Number(parts[parts.length - 2]);
    const hour = parts.length === 3 ? Number(parts[0]) : 0;
    if (![sec, minute, hour].every(Number.isFinite)) return null;
    if (minute < 0 || minute >= 60 || hour < 0 || sec < 0 || sec >= 60) return null;
    return Math.round((hour * 3600 + minute * 60 + sec) * 1000);
  }

  function parseVttTimingLine(line) {
    const match = String(line || "").match(
      /^\s*([^\s]+)\s+-->\s+([^\s]+)(?:\s+.*)?$/
    );
    if (!match) return null;
    const startMs = parseVttTimestamp(match[1]);
    const endMs = parseVttTimestamp(match[2]);
    if (startMs == null || endMs == null || endMs < startMs) return null;
    return { startMs, endMs, time: line };
  }

  // Unlike parseVttBlocks(), this retains cue order and exact numeric timing,
  // which is the stable primary key used by the Transcript panel adapter.
  function parseVttCues(vttText) {
    const lines = String(vttText || "").replace(/\r/g, "").split("\n");
    const cues = [];
    for (let i = 0; i < lines.length; i += 1) {
      const timing = parseVttTimingLine(lines[i]);
      if (!timing) continue;
      let id = "";
      if (i > 0 && lines[i - 1].trim() && !/^WEBVTT(?:\s|$)/i.test(lines[i - 1]) && !lines[i - 1].includes("-->")) {
        id = lines[i - 1].trim();
      }
      const text = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "") {
        text.push(lines[j]);
        j += 1;
      }
      cues.push({
        id,
        index: cues.length,
        startMs: timing.startMs,
        endMs: timing.endMs,
        start: timing.startMs / 1000,
        end: timing.endMs / 1000,
        time: timing.time,
        text: text.join("\n"),
      });
      i = j;
    }
    return cues;
  }

  function normalizeCueText(text) {
    return String(text || "")
      .replace(/\r/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isAlreadyBilingualVtt(translatedVtt, originalVtt) {
    const trans = parseVttBlocks(translatedVtt);
    const orig = parseVttBlocks(originalVtt);
    if (trans.length === 0 || orig.length === 0) return false;
    const n = Math.min(trans.length, orig.length, 120);
    if (n < 3) return false;

    let hit = 0;
    let checked = 0;
    for (let i = 0; i < n; i += 1) {
      const t = normalizeCueText(trans[i].text);
      const o = normalizeCueText(orig[i].text);
      if (!t || !o) continue;
      checked += 1;
      if (t.includes(o)) hit += 1;
    }
    if (checked < 3) return false;
    return hit / checked >= 0.35;
  }

  function hasCjk(text) {
    return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(String(text || ""));
  }

  // A source snapshot must be single-language. A rendered bilingual track is
  // still valid WebVTT, so syntax validation alone cannot distinguish it from
  // the original. Detect the high-confidence contamination pattern used by
  // this extension's own renderer: most cues contain both CJK and non-CJK text
  // lines. This is deliberately a conservative detector; one multilingual
  // cue or an ordinary line-wrapped English cue is not enough to reject input.
  function inspectProbableBilingualVtt(vttText, {
    minimumCues = 3,
    minimumRatio = 0.6,
  } = {}) {
    const cues = parseVttCues(vttText);
    const mixedCues = cues.filter((cue) => {
      const lines = String(cue.text || "").split("\n").map((line) => line.trim()).filter(Boolean);
      return lines.length >= 2 && lines.some(hasCjk) && lines.some((line) => !hasCjk(line));
    }).length;
    const multilineCueCount = cues.filter((cue) =>
      String(cue.text || "").split("\n").filter((line) => line.trim()).length > 1
    ).length;
    const ratio = cues.length > 0 ? mixedCues / cues.length : 0;
    return {
      probable: cues.length >= minimumCues && mixedCues >= minimumCues && ratio >= minimumRatio,
      cueCount: cues.length,
      mixedCueCount: mixedCues,
      multilineCueCount,
      ratio,
    };
  }

  function reorderCueTextZhFirst(text) {
    const parts = String(text || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2) return String(text || "");
    const zhIdx = parts.findIndex((p) => hasCjk(p));
    if (zhIdx <= 0) return parts.join("\n");
    const zhLine = parts[zhIdx];
    const rest = parts.filter((_, i) => i !== zhIdx);
    return [zhLine, ...rest].join("\n");
  }

  function normalizeBilingualOrderZhFirst(vttText) {
    const lines = String(vttText || "").replace(/\r/g, "").split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      out.push(lines[i]);
      if (!lines[i].includes("-->")) continue;
      const cueText = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "") {
        cueText.push(lines[j]);
        j += 1;
      }
      out.push(reorderCueTextZhFirst(cueText.join("\n")));
      out.push("");
      i = j;
    }
    return out.join("\n");
  }

  function extractPrimaryTranslatedVtt(vttText) {
    const lines = String(vttText || "").replace(/\r/g, "").split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      out.push(lines[i]);
      if (!lines[i].includes("-->")) continue;
      const cueText = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "") {
        cueText.push(lines[j]);
        j += 1;
      }
      const parts = cueText.map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) {
        out.push("");
      } else {
        const zhLine = parts.find((p) => hasCjk(p));
        out.push(zhLine || parts[0]);
      }
      out.push("");
      i = j;
    }
    return out.join("\n");
  }

  function applyCueBottom(vttText, size) {
    const linePos = CUE_LINE_MAP[size] || CUE_LINE_MAP[DEFAULT_SUBTITLE_SIZE];
    return String(vttText || "")
      .split("\n")
      .map((line) => {
        if (!line.includes("-->")) return line;
        if (/\sline:[^\s]+/.test(line)) return line;
        let out = line
          .replace(/\sline:[^\s]+/g, "")
          .replace(/\sposition:[^\s]+/g, "")
          .replace(/\salign:[^\s]+/g, "")
          .trimEnd();
        out += ` line:${linePos} position:50% align:middle`;
        return out;
      })
      .join("\n");
  }

  function buildIncrementalPreviewVtt(partialVtt, originalVtt, options = {}) {
    const placeholder = options.placeholder || SUBTITLE_PENDING_LABEL;
    const failureLabel = options.failureLabel || SUBTITLE_FAILURE_LABEL;
    const markPending = options.markPending !== false;
    const failedCues = new Set(
      (Array.isArray(options.failedCues) ? options.failedCues : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    );
    const trans = parseVttBlocks(partialVtt);
    const orig = parseVttBlocks(originalVtt);
    const n = Math.min(trans.length, orig.length);
    const lines = ["WEBVTT", ""];
    for (let i = 0; i < n; i += 1) {
      const origText = cueTextToLine(orig[i].text);
      const transText = cueTextToLine(trans[i].text);
      const failed = failedCues.has(i + 1);
      const pending = markPending && !failed && (!transText || normalizeCueText(transText) === normalizeCueText(origText));
      lines.push(String(i + 1));
      lines.push(trans[i].time);
      lines.push(failed ? failureLabel : (pending ? placeholder : trans[i].text));
      lines.push("");
    }
    return lines.join("\n");
  }

  ns.vtt = {
    formatVttTime,
    cueTextToLine,
    normalizeTimedText,
    parseVttStats,
    parseVttBlocks,
    parseVttTimestamp,
    parseVttTimingLine,
    parseVttCues,
    inspectProbableBilingualVtt,
    isAlreadyBilingualVtt,
    normalizeBilingualOrderZhFirst,
    extractPrimaryTranslatedVtt,
    applyCueBottom,
    buildIncrementalPreviewVtt,
  };
})();
