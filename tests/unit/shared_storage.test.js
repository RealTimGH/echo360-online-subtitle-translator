import {describe,it,expect,vi} from "vitest";
import {evalModule,makeFullNs,makeStorageMock} from "../helpers/load-module.js";

function contexts() {
  const local = makeStorageMock();
  evalModule("shared_storage.js");
  const owner = globalThis.Echo360SharedStorage.createOwner(local);
  const page = () => {
    window.Echo360Translator = makeFullNs({browserApi:{storage:{local},runtime:{sendMessage:vi.fn(msg=>owner.handle(msg))}}});
    evalModule("storage.js"); evalModule("manual_translation.js");
    return window.Echo360Translator;
  };
  return {local,owner,a:page(),b:page()};
}
const entry = (key, overrides={}) => ({cacheKey:key,sourceKey:"source",configSig:"config",translatedVtt:"WEBVTT\n",...overrides});

describe("background storage authority across isolated extension contexts", () => {
  it("retains simultaneous cache writes from two pages", async () => {
    const {a,b} = contexts();
    expect(await Promise.all([a.storage.setCacheStore(entry("a")),b.storage.setCacheStore(entry("b"))])).toEqual([{ok:true},{ok:true}]);
    expect((await a.storage.getCacheStore("a")).cacheKey).toBe("a");
    expect((await b.storage.getCacheStore("b")).cacheKey).toBe("b");
  });
  it("does not resurrect a deleted slot when another page touches an old entry", async () => {
    const {a,b,local} = contexts();
    await a.storage.setCacheStore(entry("a")); await b.storage.setCacheStore(entry("b"));
    local._store.echo360TranslatedVttCache.entries.a.usedAt = 1;
    await Promise.all([a.storage.getCacheStore("a"),b.storage.setCacheStore(null,"b")]);
    expect(await a.storage.getCacheStore("b")).toBeNull();
  });
  it("merges disjoint cues and rejects stale edits to a previously committed cue", async () => {
    const {a,b,local} = contexts();
    const x={sessionId:"course",accepted:{c1:"甲"}}, y={sessionId:"course",accepted:{c2:"乙"}};
    await a.manualTranslation.saveProgress(x);
    await b.manualTranslation.saveProgress(y);
    expect(local._store.echo360_manual_progress_v3.accepted).toEqual({c1:"甲",c2:"乙"});
    x.accepted.c1="甲的新版本";
    await a.manualTranslation.saveProgress(x);
    y.accepted.c1="旧页面覆盖";
    await b.manualTranslation.saveProgress(y);
    expect(local._store.echo360_manual_progress_v3.accepted).toEqual({c1:"甲的新版本",c2:"乙"});
  });
  it("filters corrupt shared cues and lets a later valid translation repair them", async () => {
    const {a,local} = contexts();
    const sessionId = "manual:v3:repair:ZH";
    local._store.echo360_manual_progress_v3 = {
      sessionId,
      savedAt: Date.now(),
      accepted: { c1: "not a translation" },
    };
    const workflow = {
      sessionId,
      target: "ZH",
      records: [
        { id: "c1", source: "Welcome to class.", rawSource: "Welcome to class.", literals: [] },
        { id: "c2", source: "Open the workbook.", rawSource: "Open the workbook.", literals: [] },
      ],
      accepted: {},
    };

    const restored = await a.manualTranslation.restoreProgress(workflow);
    expect(restored.accepted).toEqual({});
    restored.accepted.c2 = "请打开练习册。";
    await a.manualTranslation.saveProgress(restored);
    // The authority returns the union, but an invalid cue must not leak back
    // into the live workflow while another valid cue is being saved.
    expect(restored.accepted).toEqual({ c2: "请打开练习册。" });
    expect(local._store.echo360_manual_progress_v3.accepted).toEqual({ c1: "not a translation", c2: "请打开练习册。" });

    restored.accepted.c1 = "欢迎来到课堂。";
    await a.manualTranslation.saveProgress(restored);

    expect(local._store.echo360_manual_progress_v3.accepted).toEqual({ c1: "欢迎来到课堂。", c2: "请打开练习册。" });
  });
  it("drops progress from a future-dated checkpoint outside the clock-skew allowance", async () => {
    const {owner,local} = contexts();
    local._store.echo360_manual_progress_v3 = {
      sessionId: "manual:v3:future:ZH",
      savedAt: Date.now() + 6 * 60_000,
      accepted: { c1: "陈旧译文" },
    };
    await owner.saveProgress({ sessionId: "manual:v3:future:ZH", accepted: { c2: "新译文" } }, {});
    expect(local._store.echo360_manual_progress_v3.accepted).toEqual({ c2: "新译文" });
  });
  it("atomically installs manual overrides and rejects late machine commits", async () => {
    const {a,b} = contexts();
    await a.storage.setCacheStore(entry("merged",{configSig:"config::sentence-merge-v2"}));
    const manual = entry("plain",{manualImport:true,translatedVtt:"manual"});
    await b.storage.setCacheStore(manual,"",{invalidateMergeVariants:true});
    expect(await a.storage.getCacheStore("merged")).toBeNull();
    const late = await a.storage.setCacheStore(entry("merged",{configSig:"config::sentence-merge-v2"}));
    expect(late).toMatchObject({ok:true,superseded:true,entry:{manualImport:true}});
    await a.storage.setCacheStore(null,"merged",{clearManualOverride:{sourceKey:"source",configSig:"config::sentence-merge-v2"}});
    expect(await b.storage.getCacheStore("plain")).toBeNull();
    expect(await a.storage.setCacheStore(entry("merged"))).toEqual({ok:true});
  });
  it("never falls back to unsafe page writes when messaging fails", async () => {
    const {a,local} = contexts();
    a.browserApi.runtime.sendMessage.mockRejectedValue(new Error("worker disconnected"));
    await expect(a.storage.getCacheStore("a")).rejects.toThrow("worker disconnected");
    expect(await a.storage.setCacheStore(entry("a"))).toMatchObject({ok:false});
    expect(local.set).not.toHaveBeenCalled();
  });
});
