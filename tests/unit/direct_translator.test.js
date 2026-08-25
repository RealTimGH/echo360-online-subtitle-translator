import { beforeAll, describe, expect, it } from "vitest";
import { evalModule } from "../helpers/load-module.js";

let translator;

beforeAll(() => {
  evalModule("direct_translator.js");
  translator = window.Echo360DirectTranslator;
});

describe("direct translator provider safeguards", () => {
  it("uses the researched Google web default cadence without raising concurrency", () => {
    const adapter = translator.getProviderAdapter("google-web");

    expect(adapter.concurrencyCap).toBe(48);
    expect(adapter.defaultRps).toBe(12);
  });
});
