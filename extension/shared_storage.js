// Only the extension service worker creates the production owner. Content
// scripts call it through runtime messaging; their page origins cannot share
// a Web Lock or make chrome.storage read/modify/write transactional.
(() => {
  function createOwner(storage) {
    const extensionApi = { storage: { local: storage } };
    const CACHE_KEY = "echo360TranslatedVttCache";
    const PROGRESS_KEY = "echo360_manual_progress_v3";
    const PROGRESS_TTL_MS = 30 * 86400000;
    const ALLOWED_PROGRESS_CLOCK_SKEW_MS = 5 * 60_000;
    function hasFreshProgressTimestamp(value) {
      const savedAt = Number(value);
      const age = Date.now() - savedAt;
      return Number.isFinite(savedAt) && savedAt > 0 &&
        age >= -ALLOWED_PROGRESS_CLOCK_SKEW_MS && age <= PROGRESS_TTL_MS;
    }
    const sameScope = (a, b) => !!a?.sourceKey && a.sourceKey === b?.sourceKey &&
      !!a.configSig && String(a.configSig).replace(/::sentence-merge-v[0-9]+$/, "") ===
      String(b.configSig || "").replace(/::sentence-merge-v[0-9]+$/, "");
    // Subtitle results are stored as a keyed map: one slot per cacheKey
    // (source URL + source hash + translation config + sentence-merge version). Writes are
    // serialized. There is no fixed entry cap; Chrome quota is the only bound.
    const SUBTITLE_CACHE_SCHEMA = "subtitle-cache-v2";
    const SUBTITLE_CACHE_TOUCH_INTERVAL_MS = 60_000;
    let subtitleCacheMutation = Promise.resolve();

    function enqueueSubtitleCacheMutation(operation) {
      const next = subtitleCacheMutation.catch(() => {}).then(operation);
      subtitleCacheMutation = next.catch(() => {});
      return next;
    }

    function emptySubtitleCache() {
      return { schema: SUBTITLE_CACHE_SCHEMA, entries: {} };
    }

    function isLegacySubtitleCacheEntry(value) {
      return !!(value && typeof value === "object" && !Array.isArray(value)
        && value.schema !== SUBTITLE_CACHE_SCHEMA
        && typeof value.translatedVtt === "string"
        && typeof value.cacheKey === "string");
    }

    function normalizeSubtitleCache(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptySubtitleCache();
      if (raw.schema === SUBTITLE_CACHE_SCHEMA && raw.entries && typeof raw.entries === "object" && !Array.isArray(raw.entries)) {
        return { schema: SUBTITLE_CACHE_SCHEMA, entries: { ...raw.entries } };
      }
      if (isLegacySubtitleCacheEntry(raw)) {
        return { schema: SUBTITLE_CACHE_SCHEMA, entries: { [raw.cacheKey]: { ...raw } } };
      }
      return emptySubtitleCache();
    }

    function sanitizeSubtitleCache(store) {
      const entries = {};
      for (const [key, entry] of Object.entries(store?.entries || {})) {
        if (entry && typeof entry === "object" && typeof entry.translatedVtt === "string") {
          entries[key] = entry;
        }
      }
      return { schema: SUBTITLE_CACHE_SCHEMA, entries };
    }

    function oldestSubtitleCacheKey(store, keepKey) {
      let oldestKey = "";
      let oldestAt = Infinity;
      for (const [key, entry] of Object.entries(store?.entries || {})) {
        if (key === keepKey) continue;
        const at = Number(entry?.usedAt || entry?.createdAt || 0);
        if (!oldestKey || at < oldestAt || (at === oldestAt && key < oldestKey)) {
          oldestKey = key;
          oldestAt = at;
        }
      }
      return oldestKey;
    }

    async function readSubtitleCache() {
      const obj = await extensionApi.storage.local.get(CACHE_KEY);
      return normalizeSubtitleCache(obj[CACHE_KEY]);
    }

    function isStorageCapacityError(err) {
      const detail = `${err?.name || ""} ${err?.code || ""} ${err?.message || err || ""}`;
      // Rate limits, permission errors and interrupted storage operations are
      // not capacity failures. Dropping entries cannot fix those errors.
      if (/MAX_WRITE_OPERATIONS|rate.?limit|writes?\s+per/i.test(detail)) return false;
      return /QUOTA_BYTES|QuotaExceededError|NS_ERROR_DOM_QUOTA_REACHED|quota\s+(?:has\s+been\s+)?exceeded|exceed(?:ed|s)?\s+.*quota/i.test(detail);
    }

    async function persistSubtitleCache(store, keepKey = "", { allowEviction = false } = {}) {
      const next = sanitizeSubtitleCache(store);
      while (true) {
        try {
          await extensionApi.storage.local.set({ [CACHE_KEY]: next });
          return;
        } catch (err) {
          if (!allowEviction || !isStorageCapacityError(err)) throw err;
          const dropKey = oldestSubtitleCacheKey(next, keepKey);
          if (!dropKey) throw err;
          delete next.entries[dropKey];
        }
      }
    }

    function cacheWriteError(err) {
      const error = err instanceof Error ? err : new Error(String(err || "缓存写入失败"));
      error.code = error.code || "CACHE_WRITE_FAILED";
      console.error("[echo360-translator][storage] subtitle cache write failed", globalThis.Echo360Translator?.errorUtils?.serializeError?.(error, { phase: "cache" }) || {
        code: error.code,
        message: error.message,
      });
      return { ok: false, error };
    }

    async function getCacheStore(cacheKey) {
      const key = String(cacheKey || "").trim();
      if (!key) return null;
      return enqueueSubtitleCacheMutation(async () => {
        const store = await readSubtitleCache();
        const entry = store.entries[key];
        if (!entry || typeof entry !== "object" || typeof entry.translatedVtt !== "string") return null;
        const now = Date.now();
        if (now - Number(entry.usedAt || entry.createdAt || 0) >= SUBTITLE_CACHE_TOUCH_INTERVAL_MS) {
          store.entries[key] = { ...entry, usedAt: now };
          try {
            await persistSubtitleCache(store);
          } catch {
            // A failed recency write must not hide a valid cache hit.
          }
        }
        return store.entries[key];
      });
    }

    async function setCacheStore(entryOrNull, cacheKey = "", options = {}) {
      return enqueueSubtitleCacheMutation(async () => {
        try {
          const deleteKey = String(cacheKey || "").trim();
          if (entryOrNull == null) {
            if (!deleteKey) {
              await persistSubtitleCache(emptySubtitleCache());
              return { ok: true };
            }
            const store = await readSubtitleCache();
            delete store.entries[deleteKey];
            if (options.clearManualOverride) {
              for (const [key, entry] of Object.entries(store.entries)) {
                if (entry.manualImport === true && sameScope(entry, options.clearManualOverride)) delete store.entries[key];
              }
            }
            await persistSubtitleCache(store);
            return { ok: true };
          }
          if (!entryOrNull || typeof entryOrNull !== "object" || Array.isArray(entryOrNull)) {
            return cacheWriteError(Object.assign(new Error("字幕缓存条目无效"), { code: "CACHE_WRITE_FAILED" }));
          }
          const key = String(entryOrNull.cacheKey || deleteKey).trim();
          if (!key || typeof entryOrNull.translatedVtt !== "string") {
            return cacheWriteError(Object.assign(new Error("字幕缓存缺少 cacheKey 或译文"), { code: "CACHE_WRITE_FAILED" }));
          }
          const now = Date.now();
          const store = await readSubtitleCache();
          const manualEntry = Object.values(store.entries).find(entry => entry.manualImport === true && sameScope(entry, entryOrNull));
          if (manualEntry && entryOrNull.manualImport !== true) {
            return { ok: true, superseded: true, entry: manualEntry };
          }
          if (options.invalidateMergeVariants === true && entryOrNull.manualImport === true) {
            for (const [otherKey, entry] of Object.entries(store.entries)) {
              if (sameScope(entry, entryOrNull)) delete store.entries[otherKey];
            }
          }
          store.entries[key] = {
            ...entryOrNull,
            cacheKey: key,
            createdAt: Number(entryOrNull.createdAt) || now,
            usedAt: now,
          };
          await persistSubtitleCache(store, key, { allowEviction: true });
          return { ok: true };
        } catch (err) {
          return cacheWriteError(err);
        }
      });
    }


    function saveProgress(entry, baseAccepted = {}) {
      return enqueueSubtitleCacheMutation(async () => {
        if (!entry || typeof entry.sessionId !== "string" || !entry.sessionId ||
            !entry.accepted || typeof entry.accepted !== "object" || Array.isArray(entry.accepted)) {
          throw Object.assign(new Error("Invalid manual progress"), {code:"INVALID_REQUEST"});
        }
        const previous = (await storage.get(PROGRESS_KEY))[PROGRESS_KEY];
        const current = previous?.sessionId === entry.sessionId && hasFreshProgressTimestamp(previous.savedAt)
          ? previous.accepted || {} : {};
        const accepted = { ...current };
        for (const [id, value] of Object.entries(entry.accepted)) {
          if (typeof value !== "string" || ["__proto__", "constructor", "prototype"].includes(id)) continue;
          // A stale snapshot can add missing cues but cannot overwrite a cue
          // changed since that caller's last observed version (first commit wins).
          if (!Object.hasOwn(current, id) || current[id] === baseAccepted[id]) accepted[id] = value;
        }
        const saved = { ...entry, accepted, savedAt: Date.now() };
        if (saved.partialCache) {
          saved.partialCache = { ...saved.partialCache,
            failedIds: (saved.partialCache.failedIds || []).filter(id => !Object.hasOwn(accepted, id)) };
          if (saved.partialCache.metrics) saved.partialCache.metrics = { ...saved.partialCache.metrics,
            translated: Object.keys(accepted).length,
            failed: Math.max(0, saved.partialCache.metrics.total - Object.keys(accepted).length) };
        }
        await storage.set({ [PROGRESS_KEY]: saved });
        return saved;
      });
    }
    async function handle(message) {
      try {
        let data;
        if (message.operation === "cache-get") data = await getCacheStore(message.cacheKey);
        else if (message.operation === "cache-set") data = await setCacheStore(message.entry, message.cacheKey, message.options || {});
        else if (message.operation === "progress-save") data = await saveProgress(message.entry, message.baseAccepted || {});
        else throw Object.assign(new Error("Unknown storage operation"), {code:"INVALID_REQUEST"});
        if (data?.error instanceof Error) data = { ...data, error: {code:data.error.code, message:data.error.message} };
        return {ok:true, data};
      } catch (error) {
        return {ok:false, error: {code:error.code || "CACHE_READ_FAILED", message:String(error.message || error)}};
      }
    }
    return { getCacheStore, setCacheStore, saveProgress, handle };
  }
  globalThis.Echo360SharedStorage = { createOwner };
})();
