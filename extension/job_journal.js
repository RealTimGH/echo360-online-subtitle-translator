(function(root) {
  "use strict";
  // A single background owner serializes bounded, credential-free snapshots.
  // A stopped worker cannot resume its fetches: recovery reports interruption
  // explicitly instead of silently issuing paid provider requests again.
  function createJournal(storage, {maxEntries = 10, maxChars = 5_000_000, ttlMs = 3_600_000} = {}) {
    const key = "echo360DirectJobJournal";
    let queue = Promise.resolve();
    function save(job, owner) {
      const snapshot = JSON.parse(JSON.stringify({job, owner}));
      const operation = queue.catch(() => {}).then(async () => {
        const stored = (await storage.get(key))[key];
        const entries = stored && typeof stored === "object" && !Array.isArray(stored) ? {...stored} : {};
        entries[snapshot.job.jobId] = snapshot;
        let chars = 0;
        const retained = {};
        for (const entry of Object.values(entries).sort((a, b) => (b?.job?.updatedAt || 0) - (a?.job?.updatedAt || 0))) {
          if (!entry?.job?.jobId || Date.now() - entry.job.updatedAt > ttlMs) continue;
          const size = JSON.stringify(entry).length;
          if (Object.keys(retained).length >= maxEntries || chars + size > maxChars) continue;
          chars += size;
          retained[entry.job.jobId] = entry;
        }
        await storage.set({[key]: retained});
      });
      queue = operation;
      return operation;
    }
    async function recover(id, owner) {
      await queue.catch(() => {});
      const entry = (await storage.get(key))[key]?.[id];
      if (!entry?.job || entry.owner !== owner || Date.now() - entry.job.updatedAt > ttlMs) return null;
      const job = JSON.parse(JSON.stringify(entry.job));
      if (job.status === "queued" || job.status === "running") {
        job.status = "failed";
        job.error_code = "JOB_INTERRUPTED";
        job.error = "扩展后台已重启，翻译任务已中断；已保留最近进度，请手动重试";
        job.error_detail = {code: job.error_code, message: job.error, phase:"translation", retryable:true};
        job.result = null;
      }
      return job;
    }
    return {save, recover};
  }
  root.Echo360JobJournal = {createJournal};
})(globalThis);
