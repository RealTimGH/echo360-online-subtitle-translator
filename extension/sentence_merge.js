(() => {
  // Sentence merging deliberately lives beside the VTT parser instead of in
  // the translation service.  It is a small, deterministic source transform:
  // a provider sees sentence-sized units and the renderer projects complete
  // translations back onto the original cue timeline without guessing word
  // timings. A source cue may belong to two adjacent sentence groups.
  const root = typeof window !== "undefined" ? window : globalThis;
  const ns = root.Echo360Translator || (root.Echo360Translator = {});

  const DEFAULT_MAX_CUES = 6;
  const DEFAULT_MAX_DURATION_MS = 18 * 1000;
  const DEFAULT_MAX_CHARS = 360;
  const SOFT_WORDS = 28;
  const MAX_WORDS = 48;
  const MAX_GAP_MS = 1500;

  const TAG_RE = /<\/?(?:v|c|i|b|u|ruby|rt|lang)(?=[\s.>])[^>]*>|<(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}>/g;
  const ABBREVIATIONS = new Set([
    "mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st", "mt",
    "vs", "etc", "dept", "est", "fig", "inc", "ltd", "jan", "feb",
    "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov",
    "dec", "a.m", "p.m", "e.g", "i.e", "u.s", "u.k", "no", "approx",
    "ph.d", "m.d", "b.sc", "m.sc", "b.a", "m.a", "cf", "al", "vol", "pp",
  ]);

  function asText(value) {
    return value == null ? "" : String(value);
  }

  function parseTimestamp(value) {
    const text = asText(value).trim().replace(",", ".");
    const parts = text.split(":");
    if (parts.length !== 2 && parts.length !== 3) return null;
    const seconds = Number(parts[parts.length - 1]);
    const minutes = Number(parts[parts.length - 2]);
    const hours = parts.length === 3 ? Number(parts[0]) : 0;
    if (![hours, minutes, seconds].every(Number.isFinite)) return null;
    if (hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  }

  function parseTimingLine(line) {
    const value = asText(line);
    const match = value.match(/^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
    if (!match) return null;
    const startMs = parseTimestamp(match[1]);
    const endMs = parseTimestamp(match[2]);
    if (startMs == null || endMs == null || endMs < startMs) {
      return { valid: false, startMs, endMs, time: value };
    }
    return { valid: true, startMs, endMs, time: value };
  }

  function normalizeCueRecord(record, index) {
    const startMs = Number(record?.startMs);
    const endMs = Number(record?.endMs);
    const valid = record?.valid !== false && Number.isFinite(startMs) && Number.isFinite(endMs) &&
      startMs >= 0 && endMs >= startMs;
    return {
      id: asText(record?.id),
      index,
      startMs: valid ? Math.round(startMs) : null,
      endMs: valid ? Math.round(endMs) : null,
      time: asText(record?.time),
      text: asText(record?.text),
      valid,
    };
  }

  function parseCueArray(value) {
    if (!Array.isArray(value)) return null;
    return value.map((record, index) => normalizeCueRecord(record, index));
  }

  function parseVttRecords(value) {
    const arrayRecords = parseCueArray(value);
    if (arrayRecords) return arrayRecords;

    const text = asText(value).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (!text) return [];
    const lines = text.split("\n");
    const records = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes("-->")) continue;
      const timing = parseTimingLine(lines[i]);
      if (!timing) continue;
      let j = i + 1;
      const cueText = [];
      while (j < lines.length && lines[j].trim() !== "") {
        // A malformed block can contain another timing line before a blank
        // separator. Keep the later cue recoverable and do not eat it as text.
        if (j > i + 1 && lines[j].includes("-->") && parseTimingLine(lines[j])) break;
        cueText.push(lines[j]);
        j += 1;
      }
      let id = "";
      if (i > 0 && lines[i - 1].trim() &&
        !/^WEBVTT(?:\s|$)/i.test(lines[i - 1].trim()) && !lines[i - 1].includes("-->")) {
        id = lines[i - 1].trim();
      }
      records.push(normalizeCueRecord({ ...timing, id, text: cueText.join("\n"), valid: timing.valid }, records.length));
      i = j - 1;
    }
    return records;
  }

  function flattenText(text) {
    // Provider adapters consume one text line per VTT cue. Replacing cue
    // internal line breaks is whitespace-only and leaves all source symbols,
    // tags, punctuation, and repetitions intact.
    return asText(text).replace(/\r?\n/g, " ");
  }

  function normalizeWhitespace(text) {
    return asText(text).replace(/\s+/g, " ").trim();
  }

  function stripTags(text) {
    return asText(text).replace(TAG_RE, "");
  }

  function stripTerminalClosers(text) {
    let value = stripTags(text).trim();
    // Closing quotes/brackets can appear in several Unicode forms. Keep
    // removing them until the sentence punctuation is exposed.
    const closers = /[\s"'”’»)\]}〕〉》」』】）］｝]+$/u;
    while (closers.test(value)) value = value.replace(closers, "").trimEnd();
    return value;
  }

  function finalToken(value) {
    const match = asText(value).match(/([^\s]+)$/u);
    return match ? match[1] : "";
  }

  function isAbbreviationBeforePeriod(value) {
    const token = finalToken(value).replace(/^[([{“”'"]+|[\])}〉》」』】）］｝]+$/gu, "");
    if (!token.endsWith(".")) return false;
    const withoutPeriod = token.slice(0, -1);
    const lower = withoutPeriod.toLowerCase();
    if (ABBREVIATIONS.has(lower)) return true;
    // A one-letter initial is not a sentence boundary ("Meet J. tomorrow").
    if (/^[A-Za-z]$/u.test(withoutPeriod)) return true;
    // Initials such as "U.S." and dotted abbreviations such as "e.g.".
    if (/^(?:[A-Za-z]\.)+[A-Za-z]?$/u.test(withoutPeriod)) return true;
    return false;
  }

  function isTerminalSentenceCue(text, nextText = "") {
    const stripped = stripTerminalClosers(text);
    if (!stripped) return false;

    if (/[!?！？。]$/u.test(stripped)) return true;
    if (/[…]$/u.test(stripped) || /\.{2,}$/u.test(stripped)) {
      // Ellipses can mark a hesitation inside a sentence. A lower-case
      // continuation (or paired leading ellipsis) is evidence to keep going.
      const next = stripTags(nextText).trim().replace(/^["“‘'(\[]+/, "");
      return !/^(?:[a-z]|\.{2,}|…)/u.test(next);
    }
    if (!/\.$/u.test(stripped)) return false;
    if (isAbbreviationBeforePeriod(stripped)) {
      // Some abbreviations can also end a sentence; honor a strong next
      // sentence starter, while retaining titles (Dr. Smith) and initials.
      const token = finalToken(stripped).toLowerCase();
      const next = stripTags(nextText).trimStart();
      return /^(?:etc|inc|ltd|no|ph\.d|m\.d|a\.m|p\.m|u\.s|u\.k)\.$/.test(token) &&
        /^(?:I|You|We|They|He|She|It|This|That|These|Those|The|However|Next|Then|So)\b/.test(next);
    }

    // Interior decimal/URL periods never reach here. A final prose period
    // after a number or URL is still a boundary.
    return true;
  }

  function speakerSignature(text) {
    const value = asText(text).replace(/^\s+/, "");
    const voice = value.match(/^<v(?:\s+([^>]*))?>/iu);
    if (voice) return `v:${normalizeWhitespace(voice[1] || "").toLowerCase()}`;

    // A visible name/role followed by a colon is a dialogue cue. Requiring a
    // space after the colon avoids treating clock times and URLs as speakers.
    const named = value.match(/^[“”"'‘’]?([\p{L}][\p{L}\p{M}\d ._'’-]{0,48})\s*:\s+/u);
    if (named) return `name:${normalizeWhitespace(named[1]).toLowerCase()}`;

    if (/^(?:[-–—]|\u2022)\s+/u.test(value)) return "dialogue";
    return "";
  }

  function isNonSpeech(text) {
    const value = stripTags(text).trim();
    if (!value) return false;
    if (/^[\[\(（【{][^\]\)）】}\n]{1,120}[\]\)）】}]$/u.test(value)) return true;
    if (/^[♪♫♬]+(?:\s*[♪♫♬]+)*$/u.test(value)) return true;
    if (/^(?:\[?)(?:music|applause|laughter|laughing|silence|noise)(?:\]?)$/iu.test(value)) return true;
    return false;
  }

  function isSpeakerBoundary(previous, next) {
    const previousSpeaker = speakerSignature(previous.text);
    const nextSpeaker = speakerSignature(next.text);
    if (!previousSpeaker && !nextSpeaker) return false;
    if (previousSpeaker !== nextSpeaker) return true;
    // A dash marks a new dialogue turn even when both turns use the generic
    // marker and therefore have no recoverable speaker name.
    return previousSpeaker === "dialogue" && nextSpeaker === "dialogue";
  }

  function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
  }

  function hardBoundary(previous, next) {
    if (!previous?.valid || !next?.valid) return true;
    if (!previous.text.trim() || !next.text.trim() || previous.endMs <= previous.startMs || next.endMs <= next.startMs) return true;
    if (next.startMs < previous.endMs || next.endMs < previous.endMs || next.startMs < previous.startMs) return true;
    if (next.startMs - previous.endMs > MAX_GAP_MS) return true;
    return isNonSpeech(previous.text) || isNonSpeech(next.text) || isSpeakerBoundary(previous, next);
  }

  function wordCount(text) {
    return (stripTags(text).match(/[\p{L}\p{N}]+(?:['’’-][\p{L}\p{N}]+)*/gu) || []).length;
  }

  // Keep original character offsets. We never ask a model to regenerate the
  // source, correct ASR words, or infer word-level timestamps.
  function visibleText(raw) {
    let text = "";
    const offsets = [];
    let cursor = 0;
    function append(end) {
      text += raw.slice(cursor, end);
      for (let i = cursor; i < end; i += 1) offsets.push(i);
    }
    for (const match of raw.matchAll(TAG_RE)) {
      append(match.index);
      cursor = match.index + match[0].length;
    }
    append(raw.length);
    return { text, offsets };
  }

  function activeTags(text) {
    const stack = [];
    for (const match of text.matchAll(/<(\/?)(v|c|i|b|u|ruby|rt|lang)(?=[\s.>])[^>]*>/g)) {
      const name = match[2];
      const index = stack.findLastIndex((tag) => tag.name === name);
      if (match[1]) {
        if (index >= 0) stack.splice(index);
      } else {
        // Voice annotations are often deliberately unclosed in source VTT.
        if (name === "v" && index >= 0) stack.splice(index);
        stack.push({ name, raw: match[0] });
      }
    }
    return stack;
  }

  function sourceSlice(text, start, end) {
    if (start === 0 && end === text.length) return text;
    const prefix = activeTags(text.slice(0, start)).map((tag) => tag.raw).join("");
    const slice = text.slice(start, end).trim();
    const suffix = end < text.length
      ? activeTags(prefix + slice).reverse().map((tag) => `</${tag.name}>`).join("") : "";
    return prefix + slice + suffix;
  }

  function makeRun(records) {
    let raw = "";
    const spans = records.map((cue) => {
      if (raw) raw += " ";
      const start = raw.length;
      raw += cue.text;
      return { cue, start, end: raw.length };
    });
    const visible = visibleText(raw);
    let cursor = 0;
    const cueEnds = spans.map((span) => {
      while (cursor < visible.offsets.length && visible.offsets[cursor] < span.end) cursor += 1;
      return cursor;
    });
    return { raw, spans, cueEnds, ...visible };

  }

  function groupFromRange(run, start, end) {
    const rawStart = start === 0 ? 0 : run.offsets[start];
    const rawEnd = end === run.text.length ? run.raw.length : run.offsets[end - 1] + 1;
    const members = run.spans.filter((span) => span.end > rawStart && span.start < rawEnd);
    // Empty/markup-only cues have no visible offsets and must stay recoverable.
    if (!members.length) return createGroup(run.spans[0].cue);
    const first = members[0].cue;
    const last = members[members.length - 1].cue;
    return {
      sourceIndices: members.map((span) => span.cue.index),
      text: members.map(({ cue, start: cueStart, end: cueEnd }) =>
        sourceSlice(cue.text, Math.max(rawStart, cueStart) - cueStart, Math.min(rawEnd, cueEnd) - cueStart)
      ).join(" "),
      startMs: first.startMs,
      endMs: last.endMs,
      ...(!first.valid ? { time: first.time } : {}),
    };
  }

  function sentenceEnds(text) {
    const ends = [];
    for (const match of text.matchAll(/[.!?…。！？]+["'”’»)\]}]*(?=\s|$)/gu)) {
      const end = match.index + match[0].length;
      const next = text.slice(end).trimStart();
      // Do not split quoted questions from their reporting clause.
      if (/["”’]$/.test(match[0]) && /^(?:he|she|they|I)\s+(?:said|asked|replied|whispered)\b/.test(next)) continue;
      if (isTerminalSentenceCue(text.slice(0, end), next)) ends.push(end);
    }
    if (ends[ends.length - 1] !== text.length) ends.push(text.length);
    return ends;
  }

  function independentClause(text) {
    const value = text.trimStart().replace(/^(?:(?:and|but|so|yet|then|however)\b[,]?\s+)+/i, "");
    if (/^(?:you know|you see|I mean|I think)\s*,/i.test(value)) return false;
    // Require a subject and a plausible finite verb, not a capital letter or
    // conjunction alone. This excludes lists and most dependent noun phrases.
    return /^(?:(?:I|you|we|they|he|she|it|this|that|these|those|there)\s+(?:really\s+|also\s+|already\s+|just\s+)?(?:am|is|are|was|were|have|has|had|do|does|did|can|could|will|would|shall|should|must|might|may|need|needs|want|wants|think|know|mean|means|see|expect|use|start|look|get|go|make|take|become|becomes)\b|(?:I|you|we|they|he|she|it|that|there)['’](?:m|re|ve|ll|d|s)\b|(?:a|an|the|this|that|these|those|our|your)\s+(?:[\p{L}-]+\s+){1,3}(?:is|are|was|were|has|have|can|could|may|might|will|would|should|becomes?)\b)/iu.test(value);
  }

  function clauseEnds(text, start, end) {
    const candidates = [];
    const part = text.slice(start, end);
    for (const match of part.matchAll(/[,;:]\s+/g)) {
      const cut = start + match.index + 1;
      const before = text.slice(start, cut);
      const after = text.slice(cut, end);
      if (wordCount(before) < 12 || wordCount(after) < 6) continue;
      if (!independentClause(after)) continue;
      // A fronted condition/subordinate clause needs its main clause. Likewise
      // "not only ..., but ..." and "either ..., or ..." belong together.
      const startsDependent = /^(?:(?:and|but|so),?\s+)?(?:if|unless|when|while|although|though|because|before|after|until|since|as|whether)\b/i.test(before.trim());
      const hasMainClause = [...before.matchAll(/,\s+/g)].some((comma) =>
        independentClause(before.slice(comma.index + comma[0].length)));
      if ((startsDependent && !hasMainClause) || /\b(?:not only|either|neither)\b/i.test(before)) continue;
      candidates.push(cut);
    }
    return candidates;
  }

  function withinLimits(run, start, end, limits) {
    const group = groupFromRange(run, start, end);
    return group.sourceIndices.length <= limits.maxCues &&
      group.endMs - group.startMs <= limits.maxDurationMs &&
      stripTags(group.text).length <= limits.maxChars && wordCount(group.text) <= MAX_WORDS;
  }

  function partitionSentence(run, start, end, limits, output) {
    while (start < end && /\s/.test(run.text[start])) start += 1;
    if (start >= end) return;
    const text = run.text.slice(start, end);
    const bounded = withinLimits(run, start, end, limits);
    if (bounded && wordCount(text) <= SOFT_WORDS) {
      output.push(groupFromRange(run, start, end));
      return;
    }
    const natural = clauseEnds(run.text, start, end)
      .filter((cut) => withinLimits(run, start, cut, limits));
    if (natural.length) {
      // Prefer a balanced grammatical boundary near 28 words; look ahead
      // before cutting so a cue ending in "the" cannot win by its position.
      natural.sort((a, b) => Math.abs(wordCount(run.text.slice(start, a)) - 28) -
        Math.abs(wordCount(run.text.slice(start, b)) - 28));
      const cut = natural[0];
      output.push(groupFromRange(run, start, cut));
      partitionSentence(run, cut, end, limits, output);
      return;
    }
    if (bounded) {
      output.push(groupFromRange(run, start, end));
      return;
    }
    // When a long sentence must be bounded, a clause-level comma is safer
    // than leaving "because I" or "3" on one side of an arbitrary cue cut.
    // This fallback may produce a dependent clause, not a complete sentence.
    const punctuation = [...text.matchAll(/[,;:]\s+/g)]
      .map((match) => start + match.index + 1)
      .filter((cut) => wordCount(run.text.slice(start, cut)) >= 12 &&
        wordCount(run.text.slice(cut, end)) >= 6 && withinLimits(run, start, cut, limits));
    if (punctuation.length) {
      const cut = punctuation[punctuation.length - 1];
      output.push(groupFromRange(run, start, cut));
      partitionSentence(run, cut, end, limits, output);
      return;
    }
    // No usable punctuation: prefer an existing cue boundary that does not
    // strand a function word. A single oversized source cue remains intact.
    const cues = run.cueEnds
      .filter((cut) => cut > start && cut < end && run.text.slice(start, cut).trim());
    const fits = cues.filter((cut) => withinLimits(run, start, cut, limits));
    const safe = fits.filter((cut) => !/\b(?:a|an|the|to|of|for|with|from|in|on|at|and|or|but|if|because|that|which|who|is|are|was|were|have|has|will|would|can|could|not|my|your|our|their|I|you|we|they|he|she|it|[0-9]+)\s*$/i.test(run.text.slice(start, cut)));
    const cut = safe[safe.length - 1] || fits[fits.length - 1] || cues[0];
    if (!cut) {
      output.push(groupFromRange(run, start, end));
      return;
    }
    output.push(groupFromRange(run, start, cut));
    partitionSentence(run, cut, end, limits, output);
  }

  function formatTimestamp(milliseconds) {
    const ms = Math.max(0, Math.round(Number(milliseconds) || 0));
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const remainder = ms % 1000;
    const pad2 = (value) => String(value).padStart(2, "0");
    const pad3 = (value) => String(value).padStart(3, "0");
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad3(remainder)}`;
  }

  function timingKey(startMs, endMs) {
    if (startMs == null || endMs == null) return "";
    const start = Number(startMs);
    const end = Number(endMs);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
    return `${Math.round(start)}:${Math.round(end)}`;
  }

  function createGroup(cue) {
    return {
      sourceIndices: [cue.index],
      text: asText(cue.text),
      startMs: cue.valid ? cue.startMs : null,
      endMs: cue.valid ? cue.endMs : null,
      ...(!cue.valid ? { time: cue.time } : {}),
    };
  }

  function serializeBlocks(blocks, { grouped = false } = {}) {
    const lines = ["WEBVTT", ""];
    blocks.forEach((block, index) => {
      const id = asText(block.id) || String(index + 1);
      lines.push(id);
      if (!grouped && block.time) {
        lines.push(block.time);
      } else if (block.valid && block.startMs != null && block.endMs != null) {
        lines.push(`${formatTimestamp(block.startMs)} --> ${formatTimestamp(block.endMs)}`);
      } else {
        lines.push(asText(block.time) || "00:00:00.000 --> 00:00:00.000");
      }
      const text = grouped ? flattenText(block.text) : asText(block.text);
      if (text) lines.push(text);
      lines.push("");
    });
    return lines.join("\n");
  }

  function serializeGroupVtt(groups) {
    return serializeBlocks(groups.map((group, index) => ({
      id: String(index + 1),
      valid: group.startMs != null && group.endMs != null,
      startMs: group.startMs,
      endMs: group.endMs,
      time: group.time,
      // Speaker/style/time annotations are metadata, not translation input.
      // Preserve them in group.text for English display, never send repeated
      // "<v Speaker 1>" tokens between fragments to a translation provider.
      text: stripTags(group.text),
    })), { grouped: true });
  }

  function planGroups(plan) {
    if (Array.isArray(plan)) return plan;
    if (Array.isArray(plan?.groups)) return plan.groups;
    return [];
  }

  function sourceIndexToGroups(plan) {
    const map = new Map();
    for (const group of planGroups(plan)) {
      for (const index of Array.isArray(group?.sourceIndices) ? group.sourceIndices : []) {
        const number = Number(index);
        if (Number.isInteger(number) && number >= 0) {
          if (!map.has(number)) map.set(number, []);
          map.get(number).push(group);
        }
      }
    }
    return map;
  }

  function groupTiming(group, sourceRecords) {
    let startMs = group?.startMs == null ? NaN : Number(group.startMs);
    let endMs = group?.endMs == null ? NaN : Number(group.endMs);
    const indices = Array.isArray(group?.sourceIndices) ? group.sourceIndices : [];
    if (!Number.isFinite(startMs) && indices.length) startMs = Number(sourceRecords[indices[0]]?.startMs);
    if (!Number.isFinite(endMs) && indices.length) endMs = Number(sourceRecords[indices[indices.length - 1]]?.endMs);
    return { startMs: Number.isFinite(startMs) ? Math.round(startMs) : null, endMs: Number.isFinite(endMs) ? Math.round(endMs) : null };
  }

  function indexedTranslatedRecords(translatedVtt) {
    const byTiming = new Map();
    for (const record of parseVttRecords(translatedVtt)) {
      if (!record.valid) continue;
      const key = timingKey(record.startMs, record.endMs);
      if (!key) continue;
      const list = byTiming.get(key) || [];
      list.push(record);
      byTiming.set(key, list);
    }
    return byTiming;
  }

  function takeTranslatedRecord(byTiming, key, used, expectedId = null) {
    const list = byTiming.get(key) || [];
    for (const record of list) {
      if (!used.has(record) && (expectedId == null || record.id === expectedId)) {
        used.add(record);
        return record;
      }
    }
    return null;
  }

  function duplicateTimings(groups) {
    const counts = new Map();
    for (const group of groups) {
      const key = timingKey(group.startMs, group.endMs);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  function defaultLabel(name, fallback) {
    return asText(ns.constants?.[name] || fallback);
  }

  function build(value, options = {}) {
    const records = parseVttRecords(value);
    const limits = {
      maxCues: DEFAULT_MAX_CUES,
      maxDurationMs: DEFAULT_MAX_DURATION_MS,
      maxChars: Math.min(DEFAULT_MAX_CHARS, positiveInteger(options.maxChars, DEFAULT_MAX_CHARS)),
    };
    const groups = [];
    let recordsInRun = [];
    function flush() {
      if (!recordsInRun.length) return;
      const run = makeRun(recordsInRun);
      let start = 0;
      if (!run.text.trim() || !recordsInRun[0].valid) {
        groups.push(...recordsInRun.map(createGroup));
      } else {
        for (const end of sentenceEnds(run.text)) {
          partitionSentence(run, start, end, limits, groups);
          start = end;
        }
      }
      recordsInRun = [];
    }
    for (const cue of records) {
      if (recordsInRun.length && hardBoundary(recordsInRun[recordsInRun.length - 1], cue)) flush();
      recordsInRun.push(cue);
    }
    flush();
    return { vtt: serializeGroupVtt(groups), groups };
  }

  function project(originalVtt, translatedGroupedVtt, plan, mergeEnglish = false) {
    const sourceRecords = parseVttRecords(originalVtt);
    const groups = planGroups(plan);
    if (!sourceRecords.length || !groups.length) {
      return { originalVtt, translatedVtt: translatedGroupedVtt };
    }

    const byTiming = indexedTranslatedRecords(translatedGroupedVtt);
    const usedTranslations = new Set();
    const groupTexts = new Map();
    const timingCounts = duplicateTimings(groups);
    for (const [index, group] of groups.entries()) {
      const timing = groupTiming(group, sourceRecords);
      const key = timingKey(timing.startMs, timing.endMs);
      const translated = takeTranslatedRecord(byTiming, key, usedTranslations,
        timingCounts.get(key) > 1 ? String(index + 1) : null);
      groupTexts.set(group, translated ? translated.text : "");
    }

    const groupsBySourceIndex = sourceIndexToGroups(plan);
    const projectedTranslations = sourceRecords.map((cue) => {
      const cueGroups = groupsBySourceIndex.get(cue.index) || [];
      return cueGroups.map((group) => groupTexts.get(group) || "").filter(Boolean).join("\n");
    });
    const translatedBlocks = sourceRecords.map((cue, index) => ({
      ...cue,
      text: projectedTranslations[index],
    }));
    const projectedTranslatedVtt = serializeBlocks(translatedBlocks);

    if (!mergeEnglish) return { originalVtt, translatedVtt: projectedTranslatedVtt };

    const projectedOriginalBlocks = sourceRecords.map((cue) => {
      const cueGroups = groupsBySourceIndex.get(cue.index) || [];
      return { ...cue, text: cueGroups.length ? cueGroups.map((group) => asText(group.text)).join(" ") : cue.text };
    });
    return {
      originalVtt: serializeBlocks(projectedOriginalBlocks),
      translatedVtt: projectedTranslatedVtt,
    };
  }

  function preview(translatedGroupedVtt, plan, options = {}) {
    const groups = planGroups(plan);
    if (!groups.length) return translatedGroupedVtt;

    const pendingLabel = asText(options.pendingLabel || defaultLabel("SUBTITLE_PENDING_LABEL", "正在翻译中..."));
    const failureLabel = asText(options.failureLabel || defaultLabel("SUBTITLE_FAILURE_LABEL", "[翻译失败]"));
    const failed = new Set((options.failedCues instanceof Set ? [...options.failedCues] : options.failedCues || [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0));
    const byTiming = indexedTranslatedRecords(translatedGroupedVtt);
    const usedTranslations = new Set();
    const timingCounts = duplicateTimings(groups);
    const sourceRecords = parseVttRecords(plan?.sourceVtt || "");
    const blocks = groups.map((group, index) => {
      const timing = groupTiming(group, sourceRecords);
      const key = timingKey(timing.startMs, timing.endMs);
      const translated = takeTranslatedRecord(byTiming, key, usedTranslations,
        timingCounts.get(key) > 1 ? String(index + 1) : null);
      let text;
      if (failed.has(index + 1)) {
        text = failureLabel;
      } else if (!translated || !asText(translated.text).trim()) {
        text = pendingLabel;
      } else if (options.markPending !== false &&
        normalizeWhitespace(stripTags(translated.text)) === normalizeWhitespace(stripTags(group.text))) {
        text = pendingLabel;
      } else {
        text = translated.text;
      }
      return {
        id: String(index + 1),
        valid: timing.startMs != null && timing.endMs != null,
        startMs: timing.startMs,
        endMs: timing.endMs,
        text,
      };
    });
    return serializeBlocks(blocks, { grouped: true });
  }

  function remapFailedCues(failedGroups, plan) {
    const groups = planGroups(plan);
    const failures = new Set((failedGroups instanceof Set ? [...failedGroups] : failedGroups || [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0));
    const cues = new Set();
    for (const groupNumber of failures) {
      const group = groups[groupNumber - 1];
      for (const index of Array.isArray(group?.sourceIndices) ? group.sourceIndices : []) {
        const cueNumber = Number(index) + 1;
        if (Number.isInteger(cueNumber) && cueNumber > 0) cues.add(cueNumber);
      }
    }
    return [...cues].sort((a, b) => a - b);
  }

  ns.sentenceMerge = { build, project, preview, remapFailedCues };
})();
