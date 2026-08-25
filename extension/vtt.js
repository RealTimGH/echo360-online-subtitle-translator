(() => {
  const ns = window.Echo360Translator;
  const {
    DEFAULT_SUBTITLE_SIZE,
    CUE_LINE_MAP,
    SUBTITLE_PENDING_LABEL,
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

  function parseVttStats(vttText) {
    const lines = String(vttText || "").split("\n");
    const timeRe = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
    let cueCount = 0;
    let maxEnd = 0;
    const ranges = [];
    const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    for (const line of lines) {
      const match = line.match(timeRe);
      if (!match) continue;
      cueCount += 1;
      const s = toSec(match[1], match[2], match[3], match[4]);
      const e = toSec(match[5], match[6], match[7], match[8]);
      if (e > maxEnd) maxEnd = e;
      ranges.push([s, e]);
    }
    return { cueCount, maxEnd, ranges };
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
      /([^\s]+)\s+-->\s+([^\s]+)(?:\s+.*)?$/
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
    const trans = parseVttBlocks(partialVtt);
    const orig = parseVttBlocks(originalVtt);
    const n = Math.min(trans.length, orig.length);
    const lines = ["WEBVTT", ""];
    for (let i = 0; i < n; i += 1) {
      const origText = cueTextToLine(orig[i].text);
      const transText = cueTextToLine(trans[i].text);
      const pending = !transText || normalizeCueText(transText) === normalizeCueText(origText);
      lines.push(String(i + 1));
      lines.push(trans[i].time);
      lines.push(pending ? placeholder : trans[i].text);
      lines.push("");
    }
    return lines.join("\n");
  }

  ns.vtt = {
    formatVttTime,
    cueTextToLine,
    parseVttStats,
    parseVttBlocks,
    parseVttTimestamp,
    parseVttTimingLine,
    parseVttCues,
    isAlreadyBilingualVtt,
    normalizeBilingualOrderZhFirst,
    extractPrimaryTranslatedVtt,
    applyCueBottom,
    buildIncrementalPreviewVtt,
  };
})();
