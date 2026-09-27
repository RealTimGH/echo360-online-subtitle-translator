import {afterEach, describe, it, expect, vi} from "vitest";
import {webcrypto} from "node:crypto";
import {evalModule, makeFullNs} from "../helpers/load-module.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup() {
  const values = {};
  const storage = {get:async key => ({[key]:structuredClone(values[key])}),
    set:async entries => Object.assign(values, structuredClone(entries))};
  let handler;
  const translator = {translateVtt:vi.fn()};
  window.Echo360Translator = makeFullNs();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Echo360BuildConfig", {});
  vi.stubGlobal("Echo360DirectTranslator", translator);
  vi.stubGlobal("Echo360ExtensionApi", {storage:{local:storage}, raw:{runtime:{id:"test-extension"}},
    runtime:{addOnMessageListener:listener => {handler = listener;}}});
  vi.stubGlobal("importScripts", (...files) => {
    for (const file of files) if (!["build_config.js","browser_api.js","direct_translator.js"].includes(file)) evalModule(file);
  });
  const restart = () => {evalModule("background.js"); return handler;};
  const send = restart();
  return {send, restart, translator, values};
}
const sender = {id:"test-extension", tab:{id:1}, frameId:0, documentId:"doc"};
const input = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n";
async function create(send) {
  const response = await send({type:"direct-translate-async",payload:{provider:"google-web",target:"ZH",vtt_text:input}}, sender);
  expect(response.ok).toBe(true);
  return response.data.job_id;
}

describe("background job lifecycle", () => {
  it("cancels provider work and rejects late progress and successful completion", async () => {
    const {send, translator} = setup();
    let finish, callbacks;
    translator.translateVtt.mockImplementation((_payload, handlers) => {
      callbacks = handlers;
      return new Promise(resolve => {finish = resolve;});
    });
    const id = await create(send);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    const denied = await send({type:"direct-translate-cancel",jobId:id}, {...sender,tab:{id:2}});
    expect(denied.ok).toBe(false);
    expect(callbacks.signal.aborted).toBe(false);
    expect((await send({type:"direct-translate-cancel",jobId:id}, sender)).data.cancelled).toBe(true);
    expect(callbacks.signal.aborted).toBe(true);
    callbacks.onPartialVtt("late partial", {});
    finish({translated_vtt:input.replace("Hello","你好"), warnings:[],metrics:{}});
    await Promise.resolve();
    const result = await send({type:"direct-translate-job",jobId:id}, sender);
    expect(result.data).toMatchObject({status:"failed",error_code:"TRANSLATION_CANCELLED",partial_vtt:"",result:null});
  });

  it("reports a persisted interrupted job after worker restart without provider replay", async () => {
    const {send, restart, translator} = setup();
    let finish;
    translator.translateVtt.mockImplementation(() => new Promise(resolve => {finish=resolve;}));
    const id = await create(send);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const restarted = restart();
    const response = await restarted({type:"direct-translate-job",jobId:id}, sender);
    expect(response.data).toMatchObject({status:"failed",error_code:"JOB_INTERRUPTED"});
    expect(translator.translateVtt).toHaveBeenCalledTimes(1);
    await send({type:"direct-translate-cancel",jobId:id}, sender);
    finish({});
  });
});
