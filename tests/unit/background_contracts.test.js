import { beforeAll, describe, expect, it } from "vitest";
import { evalModule } from "../helpers/load-module.js";

let contracts;

beforeAll(() => {
  evalModule("background_contracts.js");
  contracts = globalThis.Echo360BackgroundContracts;
});

describe("service-worker message contracts", () => {
  it("canonicalizes legacy target aliases", () => {
    expect(contracts.normalizeTargetCode("cantonese")).toBe("YUE");
    expect(contracts.normalizeTargetCode("zh-hk")).toBe("ZH-HK");
  });

  it("allows only the fixed backend protocol routes", () => {
    expect(contracts.isAllowedProxyRoute("/health", "GET")).toBe(true);
    expect(contracts.isAllowedProxyRoute("/translate", "POST")).toBe(true);
    expect(contracts.isAllowedProxyRoute("/translate-async", "POST")).toBe(true);
    expect(contracts.isAllowedProxyRoute("/translate-async/abc_123-def", "GET")).toBe(true);
    expect(contracts.isAllowedProxyRoute("/admin", "GET")).toBe(false);
    expect(contracts.isAllowedProxyRoute("/translate", "DELETE")).toBe(false);
    expect(contracts.isAllowedProxyRoute("/translate-async/../health", "GET")).toBe(false);
  });

  it("rejects runtime messages from another extension or an absent sender", () => {
    expect(contracts.isTrustedRuntimeSender("extension-id", { id: "extension-id" })).toBe(true);
    expect(contracts.isTrustedRuntimeSender("extension-id", { id: "other-id" })).toBe(false);
    expect(contracts.isTrustedRuntimeSender("extension-id", undefined)).toBe(false);
    expect(contracts.isTrustedRuntimeSender("", undefined)).toBe(true);
  });

});
