import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule } from "../helpers/load-module.js";

function setup({ managerShape = "direct", malformedNested = false } = {}) {
  document.body.innerHTML = `
    <section id="transcripts-panel" role="tabpanel">
      <div class="transcript-list ReactVirtualized__Grid ReactVirtualized__List" role="grid">
        <div class="ReactVirtualized__Grid__innerScrollContainer" role="rowgroup"></div>
      </div>
    </section>`;
  window.__echo360Probe = { installed: true };
  document.querySelector("#transcripts-panel").setAttribute("data-echo360-transcript-panel-token", "panel-1");
  const listHost = document.querySelector(".transcript-list");
  const hostRowHeight = ({ index }) => 50 + index;
  const list = {
    props: { rowCount: 3, rowHeight: hostRowHeight },
    recomputeRowHeights: vi.fn(),
    scrollToRow: vi.fn(),
    _scrollingContainer: listHost,
  };
  const directManager = {
    _cellCount: 3,
    _estimatedCellSize: 50,
    _cellSizeGetter: hostRowHeight,
    configure: vi.fn(function configure(config) {
      this._cellCount = config.cellCount;
      this._estimatedCellSize = config.estimatedCellSize;
      this._cellSizeGetter = config.cellSizeGetter;
    }),
    resetCell: vi.fn(),
    getCellCount() { return this._cellCount; },
    getEstimatedCellSize() { return this._estimatedCellSize; },
    getSizeAndPositionOfCell(index) {
      let offset = 0;
      for (let current = 0; current < index; current += 1) offset += this._cellSizeGetter({ index: current });
      return { offset, size: this._cellSizeGetter({ index }) };
    },
    getTotalSize() {
      let total = 0;
      for (let index = 0; index < this._cellCount; index += 1) total += this._cellSizeGetter({ index });
      return total;
    },
  };
  let manager = directManager;
  let innerManager = null;
  if (managerShape === "nested") {
    innerManager = directManager;
    if (malformedNested) delete innerManager.getSizeAndPositionOfCell;
    manager = {
      _cellSizeAndPositionManager: innerManager,
      configure: vi.fn((config) => innerManager.configure(config)),
      resetCell: vi.fn((index) => innerManager.resetCell(index)),
      getCellCount() { return innerManager.getCellCount(); },
      getEstimatedCellSize() { return innerManager.getEstimatedCellSize(); },
      getSizeAndPositionOfCell(index) { return innerManager.getSizeAndPositionOfCell(index); },
      getTotalSize() { return innerManager.getTotalSize(); },
    };
  }
  const grid = {
    props: { rowCount: 3, rowHeight: hostRowHeight },
    state: { instanceProps: { rowSizeAndPositionManager: manager }, scrollTop: 0 },
    _scrollingContainer: listHost,
    scrollToPosition: vi.fn(({ scrollTop }) => {
      listHost.scrollTop = scrollTop;
      grid.state.scrollTop = scrollTop;
    }),
  };
  list.Grid = grid;
  Object.defineProperty(listHost, "__reactFiber$fixture", {
    configurable: true,
    value: { stateNode: list, return: null },
  });
  window.Echo360Translator = {};
  evalModule("page_probe.js");
  const bridge = window.__echo360TranscriptPageBridge;
  const send = (data) => bridge.handleMessage({ source: window, data });
  return { bridge, list, grid, manager, innerManager, listHost, send, post: vi.spyOn(window, "postMessage") };
}

const message = (action, extra = {}) => ({
  source: "echo360-translator-transcript",
  version: 1,
  requestId: "req-1",
  panelToken: "panel-1",
    action,
    revision: 0,
    rowCount: 3,
    ...extra,
});

describe("MAIN-world transcript layout bridge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete window.__echo360TranscriptPageBridge;
    delete window.__echo360Probe;
  });

  it("handshakes only with a verified List/Grid and extends both rowHeight functions", () => {
    const { bridge, list, grid, manager, send } = setup();
    const capability = send(message("capabilities"));
    expect(capability).toMatchObject({ ok: true, capability: "echo-react-virtualized-v1", visibleRowCount: 3 });
    const applied = send(message("set-layout", { revision: 1, extras: [[1, 25]] }));
    expect(applied).toMatchObject({ ok: true, appliedRevision: 1 });
    expect(list.props.rowHeight({ index: 0 })).toBe(50);
    expect(list.props.rowHeight({ index: 1 })).toBe(76);
    expect(grid.props.rowHeight({ index: 1 })).toBe(76);
    expect(manager._cellSizeGetter).toBe(grid.props.rowHeight);
    expect(manager._cellSizeGetter({ index: 1 })).toBe(76);
    expect(manager.getSizeAndPositionOfCell(2)).toMatchObject({ offset: 126, size: 52 });
    expect(list.recomputeRowHeights).toHaveBeenCalledWith(1);
    send(message("restore-layout", { revision: 2 }));
    expect(manager._cellSizeGetter).toBe(list.props.rowHeight);
    expect(manager._cellSizeGetter({ index: 1 })).toBe(51);
    expect(manager.getTotalSize()).toBe(153);
  });

  it("acknowledges an unchanged layout without rebuilding the virtualized manager", () => {
    const { list, send } = setup();
    expect(send(message("capabilities"))).toMatchObject({ ok: true });
    expect(send(message("set-layout", { revision: 1, extras: [[1, 25]] }))).toMatchObject({ ok: true });
    list.recomputeRowHeights.mockClear();
    expect(send(message("set-layout", { revision: 1, extras: [[1, 25]] }))).toMatchObject({
      ok: true,
      appliedRevision: 1,
    });
    expect(list.recomputeRowHeights).not.toHaveBeenCalled();
  });

  it("supports react-virtualized ScalingCellSizeAndPositionManager nested getters", () => {
    const { list, grid, manager, innerManager, send } = setup({ managerShape: "nested" });
    expect(manager._cellSizeGetter).toBeUndefined();
    expect(manager._cellCount).toBeUndefined();
    expect(manager._estimatedCellSize).toBeUndefined();
    expect(innerManager._cellSizeGetter).toBe(grid.props.rowHeight);
    expect(send(message("capabilities"))).toMatchObject({
      ok: true,
      capability: "echo-react-virtualized-v1",
      visibleRowCount: 3,
    });
    expect(send(message("set-layout", { revision: 1, extras: [[1, 25]] }))).toMatchObject({
      ok: true,
      appliedRevision: 1,
    });
    expect(innerManager._cellSizeGetter).toBe(grid.props.rowHeight);
    expect(innerManager._cellSizeGetter({ index: 1 })).toBe(76);
    expect(send(message("restore-layout", { revision: 2 }))).toMatchObject({ ok: true });
    expect(innerManager._cellSizeGetter).toBe(list.props.rowHeight);
    expect(innerManager._cellSizeGetter({ index: 1 })).toBe(51);
  });

  it("fails closed when a nested row manager is missing its required shape", () => {
    const { send } = setup({ managerShape: "nested", malformedNested: true });
    expect(send(message("capabilities"))).toMatchObject({
      ok: false,
      error: "row-manager-not-found-or-invalid",
    });
  });

  it("re-discovers and installs a new List/Grid when React replaces the host after capability", () => {
    const { bridge, listHost, send } = setup();
    expect(send(message("capabilities"))).toMatchObject({ ok: true });

    const rowHeight = ({ index }) => 60 + index;
    const manager = {
      _cellCount: 3,
      _estimatedCellSize: 60,
      _cellSizeGetter: rowHeight,
      configure(config) {
        this._cellCount = config.cellCount;
        this._estimatedCellSize = config.estimatedCellSize;
        this._cellSizeGetter = config.cellSizeGetter;
      },
      resetCell() {},
      getCellCount() { return this._cellCount; },
      getEstimatedCellSize() { return this._estimatedCellSize; },
      getSizeAndPositionOfCell(index) { return { offset: 0, size: this._cellSizeGetter({ index }) }; },
    };
    const grid = { props: { rowCount: 3, rowHeight }, state: { instanceProps: { rowSizeAndPositionManager: manager } } };
    const list = {
      props: { rowCount: 3, rowHeight },
      recomputeRowHeights: vi.fn(),
      scrollToRow: vi.fn(),
      Grid: grid,
    };
    Object.defineProperty(listHost, "__reactFiber$fixture", {
      configurable: true,
      value: { stateNode: list, return: null },
    });

    const applied = send(message("set-layout", { revision: 1, extras: [[1, 25]] }));
    expect(applied).toMatchObject({ ok: true, appliedRevision: 1, visibleRowCount: 3 });
    expect(list.props.rowHeight({ index: 1 })).toBe(86);
    expect(manager._cellSizeGetter).toBe(grid.props.rowHeight);
    expect(bridge.statesByToken.has("panel-1")).toBe(true);
  });

  it("re-discovers a missing state after a panel commit before set-layout", () => {
    const { bridge, listHost, send } = setup();
    expect(send(message("capabilities"))).toMatchObject({ ok: true });
    bridge.statesByToken.clear();

    const rowHeight = ({ index }) => 65 + index;
    const manager = {
      _cellCount: 3,
      _estimatedCellSize: 65,
      _cellSizeGetter: rowHeight,
      configure(config) {
        this._cellCount = config.cellCount;
        this._estimatedCellSize = config.estimatedCellSize;
        this._cellSizeGetter = config.cellSizeGetter;
      },
      resetCell() {},
      getCellCount() { return this._cellCount; },
      getEstimatedCellSize() { return this._estimatedCellSize; },
      getSizeAndPositionOfCell(index) { return { offset: 0, size: this._cellSizeGetter({ index }) }; },
    };
    const grid = { props: { rowCount: 3, rowHeight }, state: { instanceProps: { rowSizeAndPositionManager: manager } } };
    const list = {
      props: { rowCount: 3, rowHeight },
      recomputeRowHeights: vi.fn(),
      scrollToRow: vi.fn(),
      Grid: grid,
    };
    Object.defineProperty(listHost, "__reactFiber$fixture", {
      configurable: true,
      value: { stateNode: list, return: null },
    });

    const applied = send(message("set-layout", { revision: 1, extras: [[2, 30]] }));
    expect(applied).toMatchObject({ ok: true, appliedRevision: 1, visibleRowCount: 3 });
    expect(list.props.rowHeight({ index: 2 })).toBe(97);
    expect(manager._cellSizeGetter).toBe(grid.props.rowHeight);
    expect(bridge.statesByToken.has("panel-1")).toBe(true);
  });

  it("rejects malformed protocol values and does not execute selectors/functions", () => {
    const { send } = setup();
    expect(send(message("capabilities", { rowCount: -1 }))).toBeNull();
    expect(send(message("unknown-action"))).toBeNull();
    expect(send(message("capabilities", { panelToken: "bad token" }))).toBeNull();
    expect(send(message("set-layout", { revision: 1, extras: [[0, 401]] }))).toBeNull();
    expect(send(message("set-layout", { revision: 1, extras: [[0, "() => alert(1)"]] }))).toBeNull();
    expect(send(message("capabilities", { transcript: "must never cross the bridge" }))).toBeNull();
    expect(send(message("set-layout", { revision: 1, extras: [[0, 20], [0, 30]] }))).toBeNull();
  });

  it("scrolls through the verified List only and restores original functions safely", () => {
    const { list, manager, grid, send } = setup();
    const originalList = list.props.rowHeight;
    send(message("capabilities"));
    send(message("set-layout", { revision: 1, extras: [[0, 40]] }));
    send(message("scroll-to-row", { rowIndex: 2 }));
    expect(list.scrollToRow).toHaveBeenCalledWith(2);
    const restored = send(message("restore-layout", { revision: 2 }));
    expect(restored).toMatchObject({ ok: true });
    expect(list.props.rowHeight).toBe(originalList);
    expect(manager._cellSizeGetter).toBe(grid.props.rowHeight);
    expect(list.recomputeRowHeights).toHaveBeenLastCalledWith(0);
    expect(send(message("scroll-to-row", { rowIndex: 1 }))).toBeNull();
  });

  it("rejects an out-of-order restore revision and releases bridge bookkeeping", () => {
    const { bridge, list, send } = setup();
    send(message("capabilities"));
    send(message("set-layout", { revision: 2, extras: [[0, 20]] }));
    expect(send(message("restore-layout", { revision: 1 }))).toBeNull();
    expect(bridge.statesByToken.has("panel-1")).toBe(true);
    bridge.restoreAll();
    expect(bridge.statesByToken.has("panel-1")).toBe(false);
    expect(list.props.rowHeight({ index: 0 })).toBe(50);
  });

  it("fails closed when props are frozen or a third party replaces the bridge", () => {
    const { list, send } = setup();
    Object.freeze(list.props);
    expect(send(message("capabilities"))).toMatchObject({ ok: false, error: "props-frozen" });

    const again = setup();
    expect(again.send(message("capabilities"))).not.toBeNull();
    again.list.props.rowHeight = () => 999;
    expect(again.send(message("set-layout", { revision: 1, extras: [[0, 20]] }))).toBeNull();
    expect(again.list.props.rowHeight({ index: 0 })).toBe(999);
  });

  it("reports model/host row-count mismatch instead of timing out silently", () => {
    const { send } = setup();
    expect(send(message("capabilities", { rowCount: 2 }))).toMatchObject({
      ok: false,
      error: "host-row-count-exceeds-model",
      hostRowCount: 3,
      modelRowCount: 2,
    });
  });

  it("treats host rowCount as a gated visible prefix and can expand it safely", () => {
    const { list, grid, manager, send } = setup();
    const modelCount = 5;
    const gated = send(message("capabilities", { rowCount: modelCount }));
    expect(gated).toMatchObject({ ok: true, visibleRowCount: 3 });
    expect(send(message("set-layout", { rowCount: modelCount, revision: 1, extras: [[1, 25], [3, 80]] }))).toMatchObject({
      ok: true,
      visibleRowCount: 3,
    });
    expect(manager._cellCount).toBe(3);
    expect(manager._cellSizeGetter({ index: 3 })).toBe(53);
    expect(send(message("scroll-to-row", { rowCount: modelCount, rowIndex: 3 }))).toBeNull();

    const newHostRowHeight = ({ index }) => 60 + index;
    list.props.rowCount = 5;
    list.props.rowHeight = newHostRowHeight;
    grid.props.rowCount = 5;
    grid.props.rowHeight = newHostRowHeight;
    manager._cellCount = 5;
    manager._cellSizeGetter = newHostRowHeight;
    const expanded = send(message("set-layout", { rowCount: modelCount, revision: 2, extras: [[3, 80]] }));
    expect(expanded).toMatchObject({ ok: true, visibleRowCount: 5 });
    expect(manager._cellCount).toBe(5);
    expect(manager._cellSizeGetter).toBe(grid.props.rowHeight);
    expect(manager._cellSizeGetter({ index: 3 })).toBe(143);
    expect(send(message("scroll-to-row", { rowCount: modelCount, rowIndex: 3 }))).toMatchObject({ ok: true, visibleRowCount: 5 });
  });

  it("rebinds coherent React rowHeight identities but rejects one-sided third-party changes", () => {
    const first = setup();
    first.send(message("capabilities"));
    const nextListHeight = ({ index }) => 70 + index;
    const nextGridHeight = ({ index }) => 70 + index;
    first.list.props.rowHeight = nextListHeight;
    first.grid.props.rowHeight = nextGridHeight;
    first.manager._cellSizeGetter = nextGridHeight;
    const rebound = first.send(message("set-layout", { revision: 1, extras: [[1, 10]] }));
    expect(rebound).toMatchObject({ ok: true });
    expect(first.grid.props.rowHeight({ index: 1 })).toBe(81);
    expect(first.manager._cellSizeGetter).toBe(first.grid.props.rowHeight);

    const unsafe = setup();
    unsafe.send(message("capabilities"));
    unsafe.list.props.rowHeight = () => 999;
    expect(unsafe.send(message("set-layout", { revision: 1, extras: [[0, 20]] }))).toBeNull();
    expect(unsafe.list.props.rowHeight({ index: 0 })).toBe(999);
  });

  it("accepts cleanup after React has coherently restored a new host identity", () => {
    const { bridge, list, grid, manager, send } = setup();
    send(message("capabilities"));
    send(message("set-layout", { revision: 1, extras: [[1, 20]] }));
    const newListHeight = ({ index }) => 80 + index;
    const newGridHeight = ({ index }) => 90 + index;
    list.props.rowHeight = newListHeight;
    grid.props.rowHeight = newGridHeight;
    manager._cellSizeGetter = newGridHeight;
    const restored = send(message("restore-layout", { revision: 2 }));
    expect(restored).toMatchObject({ ok: true });
    expect(bridge.statesByToken.has("panel-1")).toBe(false);
    expect(list.props.rowHeight).toBe(newListHeight);
    expect(grid.props.rowHeight).toBe(newGridHeight);
    expect(manager._cellSizeGetter).toBe(newGridHeight);
    expect(manager._cellSizeGetter({ index: 1 })).toBe(91);
  });

  it("does not recompute when an identical revision and extras are confirmed", () => {
    const { list, send } = setup();
    send(message("capabilities"));
    send(message("set-layout", { revision: 1, extras: [[1, 25]] }));
    const calls = list.recomputeRowHeights.mock.calls.length;
    expect(send(message("set-layout", { revision: 1, extras: [[1, 25]] }))).toMatchObject({ ok: true });
    expect(send(message("set-layout", { revision: 2, extras: [[1, 25]] }))).toMatchObject({ ok: true, appliedRevision: 2 });
    expect(list.recomputeRowHeights).toHaveBeenCalledTimes(calls);
  });

  it("preserves the first visible row when translated rows above it grow", () => {
    const { list, listHost, grid, send } = setup();
    send(message("capabilities"));
    listHost.scrollTop = 60;
    grid.state.scrollTop = 60;
    list.recomputeRowHeights.mockImplementation(() => {
      // Simulate React Virtualized's unanchored scroll correction during the
      // asynchronous Grid update. The bridge should immediately restore the
      // same row/within-row offset after this callback returns.
      listHost.scrollTop += 20;
      grid.state.scrollTop = listHost.scrollTop;
    });

    expect(send(message("set-layout", { revision: 1, extras: [[0, 40]] }))).toMatchObject({
      ok: true,
      appliedRevision: 1,
    });
    // Row 1 was 10px below the viewport before the update (row 0 was 50px);
    // after row 0 gains 40px, the same anchor is 40px lower: 60 + 40 = 100.
    expect(listHost.scrollTop).toBe(100);
    expect(grid.scrollToPosition).toHaveBeenCalledWith({ scrollTop: 100 });
  });
});
