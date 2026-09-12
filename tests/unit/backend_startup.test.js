import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule } from "../helpers/load-module.js";

describe("Argos backend startup manager", () => {
  beforeEach(() => {
    delete globalThis.Echo360BackendStartup;
    evalModule("backend_startup.js");
  });

  it.each([
    "http://127.0.0.1:8765",
    "http://localhost:8765/",
    "http://[::1]:8765",
  ])("canonicalizes %s to the IPv4 endpoint actually used by the packaged server", (url) => {
    expect(globalThis.Echo360BackendStartup.normalizeBackendUrl(url))
      .toBe("http://127.0.0.1:8765");
  });

  it("rejects remote, HTTPS, and non-default-port auto-launch targets", () => {
    const normalize = globalThis.Echo360BackendStartup.normalizeBackendUrl;
    expect(() => normalize("https://127.0.0.1:8765")).toThrowError(expect.objectContaining({ code: "BACKEND_URL_INVALID" }));
    expect(() => normalize("http://example.com:8765")).toThrowError(expect.objectContaining({ code: "BACKEND_URL_INVALID" }));
    expect(() => normalize("http://127.0.0.1:9999")).toThrowError(expect.objectContaining({ code: "ARGOS_BACKEND_PORT_UNSUPPORTED" }));
  });

  it("shares one in-flight attempt for equivalent loopback spellings", async () => {
    let healthy = false;
    let releaseLaunch;
    const launch = vi.fn(() => new Promise((resolve) => { releaseLaunch = () => { healthy = true; resolve({ id: 9 }); }; }));
    const manager = globalThis.Echo360BackendStartup.createManager({
      healthCheck: vi.fn(async () => healthy),
      launch,
      close: vi.fn(async () => {}),
      delay: vi.fn(async () => {}),
      timeoutMs: 1000,
    });

    const first = manager.ensure("http://localhost:8765");
    const second = manager.ensure("http://[::1]:8765");
    expect(manager.pendingCount()).toBe(1);
    await Promise.resolve();
    releaseLaunch();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ready: true, backendUrl: "http://127.0.0.1:8765" }),
      expect.objectContaining({ ready: true, backendUrl: "http://127.0.0.1:8765" }),
    ]);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("reissues a swallowed protocol launch and succeeds when the backend becomes healthy", async () => {
    let clock = 0;
    let launches = 0;
    const close = vi.fn(async () => {});
    const manager = globalThis.Echo360BackendStartup.createManager({
      healthCheck: vi.fn(async () => launches >= 2),
      launch: vi.fn(async () => ({ id: ++launches })),
      close,
      now: () => clock,
      delay: vi.fn(async (ms) => { clock += ms; }),
      timeoutMs: 20000,
      relaunchDelaysMs: [0, 700],
    });

    await expect(manager.ensure("http://127.0.0.1:8765")).resolves.toMatchObject({
      ready: true,
      launchAttempts: 2,
    });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("clears a failed attempt so a later user retry can launch again", async () => {
    let clock = 0;
    const launch = vi.fn(async () => ({ id: 1 }));
    const manager = globalThis.Echo360BackendStartup.createManager({
      healthCheck: vi.fn(async () => false),
      launch,
      close: vi.fn(async () => {}),
      now: () => clock,
      delay: vi.fn(async (ms) => { clock += ms; }),
      timeoutMs: 500,
      relaunchDelaysMs: [0],
    });

    await expect(manager.ensure("http://127.0.0.1:8765"))
      .rejects.toMatchObject({ code: "ARGOS_BACKEND_START_TIMEOUT" });
    expect(manager.pendingCount()).toBe(0);
    clock = 0;
    await expect(manager.ensure("http://127.0.0.1:8765"))
      .rejects.toMatchObject({ code: "ARGOS_BACKEND_START_TIMEOUT" });
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
