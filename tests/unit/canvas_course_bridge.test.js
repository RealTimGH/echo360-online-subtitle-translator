import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule } from "../helpers/load-module.js";

function setLocation(pathname) {
  Object.defineProperty(window, "location", {
    value: {
      href: `https://canvas.sydney.edu.au${pathname}`,
      hostname: "canvas.sydney.edu.au",
      pathname,
      origin: "https://canvas.sydney.edu.au",
    },
    configurable: true,
    writable: true,
  });
}

function setup(pathname = "/courses/74649/pages/block-1-part-2-inventory-cost-components?module_item_id=3203950") {
  setLocation(pathname);
  delete window.Echo360CanvasCourseBridge;
  document.body.innerHTML = "";
  evalModule("canvas_course_bridge.js");
  return window.Echo360CanvasCourseBridge;
}

describe("canvas_course_bridge", () => {
  beforeEach(() => {
    delete window.Echo360CanvasCourseBridge;
    document.body.innerHTML = "";
  });

  it("recognizes the supplied Canvas video-course page but no assessment route", () => {
    const bridge = setup();

    expect(bridge.isSafeCoursePage(
      "https://canvas.sydney.edu.au/courses/74649/pages/block-1-part-2-inventory-cost-components?module_item_id=3203950"
    )).toBe(true);
    expect(bridge.isSafeCoursePage(
      "https://canvas.sydney.edu.au/courses/75141/external_tools/11653"
    )).toBe(true);
    expect(bridge.isSafeCoursePage("https://canvas.sydney.edu.au/courses/1/quizzes/2/take")).toBe(false);
    expect(bridge.isSafeCoursePage("https://canvas.sydney.edu.au/courses/1/assignments/2/taking/3")).toBe(false);
    expect(bridge.isSafeCoursePage("https://canvas.sydney.edu.au/courses/1/modules/items/2")).toBe(false);
  });

  it("returns a minimal proof only to supported media frames", () => {
    const bridge = setup();
    const source = { postMessage: vi.fn() };
    const request = {
      source: bridge.source,
      version: bridge.version,
      action: "verify-course-page",
      requestId: "request_1234567890",
    };

    expect(bridge.handleMessage({
      source,
      origin: "https://sydney.instructuremedia.com",
      data: request,
    })).toBe(true);
    expect(source.postMessage).toHaveBeenCalledWith({
      source: bridge.source,
      version: bridge.version,
      action: "course-page-verified",
      requestId: request.requestId,
    }, "https://sydney.instructuremedia.com");

    expect(bridge.handleMessage({
      source,
      origin: "https://attacker.example",
      data: request,
    })).toBe(false);
  });

  it("refuses proof when a high-confidence quiz surface is present", () => {
    const bridge = setup();
    const form = document.createElement("form");
    form.id = "submit_quiz_form";
    document.body.appendChild(form);
    const source = { postMessage: vi.fn() };

    expect(bridge.handleMessage({
      source,
      origin: "https://sydney.instructuremedia.com",
      data: {
        source: bridge.source,
        version: bridge.version,
        action: "verify-course-page",
        requestId: "request_1234567890",
      },
    })).toBe(false);
    expect(source.postMessage).not.toHaveBeenCalled();
  });
});
