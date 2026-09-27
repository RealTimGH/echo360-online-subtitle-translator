import {describe, it, expect} from "vitest";
import {evalModule} from "../helpers/load-module.js";

function fixture(options) {
  const values = {};
  const storage = {
    get: async key => ({[key]: structuredClone(values[key])}),
    set: async items => { Object.assign(values, structuredClone(items)); },
  };
  evalModule("job_journal.js");
  const create = () => globalThis.Echo360JobJournal.createJournal(storage, options);
  return {create};
}

describe("background restart recovery", () => {
  it("recovers completed output, but never replays interrupted provider work", async () => {
    const {create} = fixture();
    const old = create();
    await old.save({jobId:"done", status:"completed", updatedAt:Date.now(), result:{translated_vtt:"译文"}}, "tab");
    await old.save({jobId:"running", status:"running", updatedAt:Date.now(), partial_vtt:"部分译文"}, "tab");
    const restarted = create();
    expect((await restarted.recover("done", "tab")).result.translated_vtt).toBe("译文");
    expect(await restarted.recover("running", "tab")).toMatchObject({status:"failed", error_code:"JOB_INTERRUPTED", partial_vtt:"部分译文"});
    expect(await restarted.recover("done", "another-tab")).toBeNull();
  });

  it("serializes snapshots and bounds lifetime and retained entries", async () => {
    const {create} = fixture({maxEntries:2, ttlMs:1000});
    const owner = create();
    await Promise.all([1,2,3].map(n => owner.save({jobId:String(n),status:"completed",updatedAt:Date.now()+n}, "tab")));
    expect(await owner.recover("1", "tab")).toBeNull();
    expect(await owner.recover("2", "tab")).not.toBeNull();
    await owner.save({jobId:"expired",status:"completed",updatedAt:Date.now()-2000}, "tab");
    expect(await owner.recover("expired", "tab")).toBeNull();
  });
});
