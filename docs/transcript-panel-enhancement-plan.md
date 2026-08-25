# Echo360 Transcript panel 双语增强开发方案

> 文档状态：设计、真实 DOM 取证、首版代码实现及 Safari Xcode 资源同步修复已完成；真实 Safari/Chrome 页面矩阵仍待手工验收
>
> 调研与代码基线日期：2026-08-24（Australia/Sydney）
>
> 目标分支：`transcript-panel`
>
> 当前基线提交：`81df396`（与 `main`、`origin/main`、`origin/transcript-panel` 一致）

## 1. 文档目的

本方案用于在不破坏 Echo360 原生 Transcript panel 既有能力的前提下，为每个英文 transcript cue 增加一行译文，并保证：

1. 原英文内容、说话人、时间同步、高亮、滚动、下载、关闭/打开等原生能力保持不变。
2. 每个英文 cue 的下一行显示对应中文译文。
3. 点击英文仍走 Echo360 原生跳转逻辑。
4. 点击中文也跳转到同一 cue 对应的视频时间。
5. 英文继续使用 Echo360 原生搜索；中文可通过同一个搜索框搜索、计数、高亮和定位。
6. Transcript panel 关闭后再打开，无须重新翻译或再次点击加载，中文自动恢复。
7. Echo360 React 重渲染、搜索高亮拆分文本节点、长 transcript 虚拟滚动时，不重复插入、不串行、不显示错误译文。
8. 不绕过 Echo360 对 Interactive Media 未答题片段的 transcript gating。

本文同时记录首版实现规格、实现交付状态和剩余验收条件，不再表示功能尚未编码。

---

## 2. 已确认的项目事实

### 2.1 来自先前项目分析任务的有效结论

先前引用任务“解析项目及两个分支”已经确认，并由本次代码检查重新核对：

- 后续开发应基于 `main` 的现有成果，不应回到已合并的 `feat/incremental-subtitle-display` 历史分支继续开发。
- 在历史基线 `main@81df396`（本分支起点）时尚无 Transcript panel 增强代码；当前首版实现已在该基线上完成。
- 当前默认视频字幕渲染路径是浏览器 `<track>`；Echo360 原生 CC DOM 注入是可选 Beta。
- Transcript-only 课时已经可以通过以下接口获得带 cue 时间的 VTT：

  ```text
  /api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/transcript-file?format=vtt
  ```

- 现有翻译链路已经支持缓存、增量 partial VTT、失败占位、重试和多 Provider。本功能不应复制翻译实现。
- `extension/vtt.js` 在历史基线时已能解析 VTT blocks，但还没有输出结构化的 `start/end` 数值；首版已补充这一层。
- `extension/controller.js` 是最合适的翻译生命周期接入点；首版已将本地缓存、增量结果、最终结果、失败预览、重试和清理统一接入 panel surface。
- 页面使用 React，现有原生 CC 注入已经证明 `MutationObserver`、幂等标记和文本匹配比依赖生成 class 名稳定。

先前任务中关于 Safari 打包和代码安全审查的结论与本功能没有直接架构依赖，不纳入 Transcript panel 的运行时架构；但由于本次真实验收浏览器是 Safari，最终交付仍必须执行第 2.3 节的 Xcode Resources 核对。

### 2.2 本次检查得到的当前状态

历史代码基线（`81df396`）：

- 14 个 test files、295 个 tests 全部通过。
- store/dev 两种构建成功，`git diff --check` 通过。
- 当时相对 `main` 没有 Transcript panel 代码差异。

当前首版实现状态：

- 21 个 test files、350 个 tests 全部通过。
- `npm run build` 的 store/dev 两种构建均成功。
- `git diff --check` 通过。
- model、new-player-v1 adapter、renderer、中文搜索桥、MAIN layout bridge、controller/storage/UI 集成和脱敏 fixtures 已交付。
- 真实 Safari 结构已确认使用 `react-virtualized` 的 `ScalingCellSizeAndPositionManager`：Grid 外层 manager 通过 `_cellSizeAndPositionManager` 组合内部 manager；MAIN bridge 已兼容该官方结构，同时保留 direct manager fixture 和 malformed nested fail-closed 检查。结构依据为 [ScalingCellSizeAndPositionManager 官方源码](https://github.com/bvaughn/react-virtualized/blob/9.22.6/source/Grid/utils/ScalingCellSizeAndPositionManager.js) 与 [CellSizeAndPositionManager 官方源码](https://github.com/bvaughn/react-virtualized/blob/9.22.6/source/Grid/utils/CellSizeAndPositionManager.js)。
- 尚未在真实登录后的 Safari/Chrome EchoVideo 页面完成手工验收矩阵，因此不能将全功能最终验收标记为完成。

### 2.3 截图后的 Safari 打包链路复核

用户截图来自 Safari，而 Safari 不是直接加载仓库 `extension/` 目录：Xcode 工程会把 Web Extension 文件列入自己的 Resources build phase。复核当前工程后发现：

- `dist/extension-store/manifest.json` 已经引用 `transcript_model.js`、`transcript_panel_adapter.js`、`transcript_search_bridge.js` 和 `transcript_panel_renderer.js`。
- 原有 Safari Xcode 工程的 PBX resources 清单仍停留在旧版，缺少上述 4 个文件；这会造成视频字幕旧链路仍可工作，但 Transcript panel 增强脚本不完整或未进入 Safari bundle。
- 当前工作区的 Safari 工程已补齐这 4 个文件在 iOS/macOS Extension targets 的 file reference 和 Resources build phase；`xcodebuild -list` 能正常解析工程。
- 如果用户使用的是另一份由 Xcode/`safari-web-extension-packager` 生成的工程，必须重新打包/重建该工程，不能只在仓库中运行 `npm run build` 后继续运行旧 App。Apple 的更新说明也要求由 Xcode 重新构建并打包 Web Extension 资源：[Updating a Safari web extension](https://developer.apple.com/documentation/safariservices/updating-a-safari-web-extension?language=objc)。

---

## 3. 外部调研结论

### 3.1 EchoVideo 原生行为是不可破坏的基准

Echo360 官方文档明确说明：

- Transcript panel 默认在播放器右侧打开。
- 当前播放位置对应的 cue 会高亮。
- 搜索输入会即时搜索，显示匹配数以及上一个/下一个按钮，并为匹配词加下划线。
- 点击任意 cue 会把媒体跳转到该 cue 的播放位置。
- Interactive Media 只显示到尚未回答的 poll 之前，transcript 和视频使用相同 gating。

来源：[EchoVideo: Viewing Media Transcripts](https://support.echo360.com/hc/en-us/articles/11077285975565-EchoVideo-Viewing-Media-Transcripts)

因此，“不改变原生 panel 功能”必须具体解释为：不替换原生 panel、不替换 cue 行、不劫持英文搜索、不修改原生匹配数和原生上下一个按钮、不提前渲染被 gate 的 cue。

### 3.2 行业共同交互模式

- Microsoft Stream 使用“可搜索 transcript block + 点击 block 跳转视频”的模式。[Microsoft Stream transcript 文档](https://support.microsoft.com/en-us/clipchamp/stream-pages/view-edit-and-manage-video-transcripts-and-captions)
- Kaltura Transcript plugin 同样支持跟随播放高亮、搜索、点击词跳转、切换 transcript 语言，并要求 pop-out 后仍保留原功能。[Kaltura Transcript plugin](https://knowledge.kaltura.com/help/pdfexport/id/62dfa2417ddf546f207c0b02)
- Language Reactor 这类语言学习扩展采用“原文保留、译文作为第二层内容”的产品模式，并在宿主视频站点上增加能力，而不是把原站点完全替换掉。[Language Reactor Get Started](https://www.languagereactor.com/help/basic)

共同设计原则是：

1. 时间码是 transcript 与视频之间的主键。
2. 原文和译文应属于同一个可点击时间单元。
3. 搜索结果定位和视频 seek 是两个相关但不同的动作：搜索箭头定位结果，点击 cue 才 seek。
4. 双语增强应保留原文，而不是把原文替换为翻译。

### 3.3 浏览器扩展和 DOM 技术约束

Chrome 官方文档说明 content script 运行于隔离世界，但与宿主页面共享 DOM，因此翻译模型、搜索索引和绝大部分 DOM 装饰逻辑都应保留在扩展世界中。[Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

`MutationObserver` 是跨现代浏览器的标准 DOM 变化监听机制，适合处理 panel 打开/关闭及 React 替换节点。[MDN MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)

子节点 click 会向父节点冒泡，因此把译文放在原 cue 的可点击容器内部，可以保留父级原生 seek handler。[MDN event bubbling](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Scripting/Event_bubbling)

插入译文时应使用 `textContent`/Text nodes，不使用 `innerHTML`；设置 `textContent` 会替换子节点，因此只允许设置扩展自己创建的节点，绝不能对 Echo360 原始 cue 容器设置它。[MDN Node.textContent](https://developer.mozilla.org/en-US/docs/Web/API/Node/textContent)

### 3.4 用户提供的真实页面证据（2026-08-24）

用户先后提供了实际课程页面截图、Canvas 外层页面 HTML，以及加载完成后的 EchoVideo iframe 内部 HTML。已经确认：

- 使用场景是 Canvas `external_tools` 中嵌入的 EchoVideo LTI 播放器。
- 截图显示的是 EchoVideo 新播放器：视频在左，Transcript panel 在右。
- Transcript tab、Search 输入、清除按钮、下载按钮和独立滚动 transcript 列表均可见。
- 当前 cue 通过左侧粉色圆点/状态样式标识。
- 页面运行于 Safari，因此 Safari 是首要真实验收浏览器，而不是可选补充项。
- Canvas 外层 HTML 中的 Echo360 iframe 为 `iframe.tool_launch`，第一份保存快照中的 `src` 仍是 `about:blank`；这份外层文档本身不能提供 Echo360 内部 selector。
- 第二份 HTML 是有效的 EchoVideo iframe 页面快照，共约 1.61 MB、10,576 行，包含 10 组 panel 快照和每组 26 个当前渲染 cue，足以建立 new-player fixture。
- panel root 是 `#transcripts-panel[role="tabpanel"][aria-labelledby="transcripts-tab"]`。
- 搜索容器是 `#search-transcripts[data-test-id="search-transcripts"]`，实际输入框的稳定标识是 `#search-transcripts_input`；`aria-label="Search"` 在部分 Safari/React 渲染路径中可能缺失，因此不能作为发现 panel 的必需条件。
- 清除与下载按钮分别有稳定的 `aria-label/title="clear transcripts"` 和 `"download transcripts"`；扩展不得修改这些节点。
- 列表是 `.transcript-list[role="grid"]`，同时带有 `ReactVirtualized__Grid ReactVirtualized__List`；其子节点 `.ReactVirtualized__Grid__innerScrollContainer[role="rowgroup"]` 在样本中高约 50,187px，但只渲染当前窗口附近的 26 行，证明它是虚拟列表。
- 每个渲染行的外层是绝对定位 wrapper，包含原生内联 `height/top`；cue 内容位于 `dd[data-test-component="Content"][title$=" sec"]` 或 `dd[data-test-component="Content"][title$=" min"]`，其后代 `span[role="button"]` 是英文可点击内容。当前 cue 的 `tabindex` 与 status icon 会变化，因此不能把当前态样式当 selector。
- Echo 的 `title` 在首分钟使用 `startMs < 60000 ? (startMs / 1000).toFixed(2) + " sec" : (startMs / 60000).toFixed(2) + " min"`；例如 `0.00 sec`、`59.99 sec`、`1.00 min`。两种单位都严格换算为毫秒，其他单位拒绝。DOM 时间只能用于近似重复文本消歧，不能替代 VTT 的精确时间。

还对页面引用的 EchoVideo 播放器 bundle 做了只读核对：

```text
https://echo360.net.au/assets/vendor/react/
528a2d24844f2a6a282b210a673d1680-echoPlayerV2FullApp.react-bundle.js
```

bundle 直接证明：

- 原生搜索调用 `searchAllCues(cues, query)`，再把 `cueIndexWithMatches/cueMatchPairs` 传给 React cue component；它搜索的是 transcript 数据模型，不会自动把扩展后来添加的中文 DOM 纳入原生结果。
- 列表使用 `CellMeasurerCache({ fixedWidth: true, defaultHeight: 0 })`、`CellMeasurer`、`deferredMeasurementCache`、`rowHeight` 和 `overscanRowCount: 10`。
- Echo 自己的 `rowHeight` 只按 `cue.content` 与 speaker 计算；缓存只在 `cues` 变化时 `clearAll()`。因此只 append 中文会保留英文高度；甚至只调用 `CellMeasurer.measure()` 也不够，因为 Echo 的 `rowHeight` 并未使用 `cache.rowHeight`。必须给现有 rowHeight 增加译文高度再重排。
- 原生列表实例已有 `scrollToRow(index)`，比用 `scrollTop` 猜虚拟行位置可靠。

`react-virtualized` 官方文档明确说明，动态内容变化后应重新测量 cell；`CellMeasurer` 的 `measure` 会更新 cache 并要求父 Grid 重排。[CellMeasurer 官方文档](https://github.com/bvaughn/react-virtualized/blob/master/docs/CellMeasurer.md) [CellMeasurer 官方源码](https://github.com/bvaughn/react-virtualized/blob/master/source/CellMeasurer/CellMeasurer.js)

结论：真实 DOM 和实际 bundle 已经把 selector、搜索数据流、虚拟化和行高风险全部确认。Phase 0 取证完成，不再需要用户补充页面资料；实现必须包含能力受限的 rowHeight 扩展/虚拟滚动桥，不能停留在单纯 DOM append。

### 3.5 翻译请求限速的最终决策（2026-08-25）

本项目的默认 `google-web` provider 调用的是 `https://translate.googleapis.com/translate_a/single` 网页端点，而不是需要项目凭据的正式 Google Cloud Translation v2/v3 API。该网页端点没有公开、稳定、可依赖的官方 QPS 合同，因此不能把 Cloud API 的配额数字直接当作网页端点的安全上限。

调研依据与实现决策如下：

1. Google Cloud 官方文档说明正式 Cloud Translation 会同时实施内容配额和请求速率配额，并建议按请求大小控制延迟；正式 v3 API 的默认请求配额是每项目每分钟 6,000 次（约 100 RPS），但该数字只适用于正式 Cloud API，不适用于本项目的无 Key 网页端点。[Google Cloud Translation quotas and limits](https://docs.cloud.google.com/translate/quotas)
2. Google 官方重试指南要求对可重试错误使用带 jitter 的截断指数退避，避免失败重试形成同步请求洪峰。[Google Cloud retry failed requests](https://docs.cloud.google.com/iam/docs/retry-strategy)
3. 因为当前端点无公开稳定上限，不能把任何固定 RPS 宣称为“安全值”。在已验证 Safari 会因高并发出现 `Load failed`、同时用户反馈 `6 RPS` 过慢的前提下，最终采用“提高平滑请求节奏、不恢复旧版并发洪峰”的折中调整：
   - 自动默认：`12 RPS`（请求之间约 `83.3ms`），约为上一版 6 RPS 的两倍吞吐。
   - 并发上限：保持 `48` 个 worker；仍由 provider 专用 cap 限制，不允许旧配置中的 `96` 直接透传。
   - 用户显式填写的正数 `rps`：继续尊重；`rps=0` 在 `google-web` 上表示使用上述受控默认值，而不是取消保护。
   - 其他 provider：仍使用用户配置的 `rps`，不受这个 Google 专用默认值影响。

对于当前约 1,395 个 cue 的课程，Google 网页端点通常是一 cue 一次请求；理想化的请求提交时间从 4 RPS 的约 349 秒、6 RPS 的约 233 秒，降至 12 RPS 的约 116 秒。实际时间仍会受到网络延迟、429/5xx、重试和拆分 fallback 影响。12 RPS 只是受控的吞吐折中，不是 Google 的官方配额或风控保证；48 worker 上限和至少两次重试继续保留。

代码位置：`extension/direct_translator.js` 的 `GOOGLE_WEB_DEFAULT_RPS`、`GOOGLE_WEB_CONCURRENCY_CAP` 和 `createRateLimiter()`；默认配置仍保留 `rps=0`，由 direct translator 在识别 `google-web` 后解析为 12 RPS。README 和设置页也已明确说明该 provider 的特殊语义。

---

## 4. 需求边界

### 4.1 必须实现

| 编号 | 需求 | 可验证结果 |
|---|---|---|
| R1 | 原文下方增加译文 | 每个成功映射的英文 cue 只有一个译文行 |
| R2 | 英文点击不变 | 原生 click handler 仍触发，跳转时间与改造前一致 |
| R3 | 中文可点击 | 点击译文后，播放位置与点击同 cue 英文一致 |
| R4 | 英文可搜索 | 原生匹配数、下划线、前后导航不受扩展影响 |
| R5 | 中文可搜索 | 在同一原生搜索框输入中文后出现译文匹配、高亮与前后定位 |
| R6 | 关闭/重开恢复 | panel DOM 被移除后重建，译文自动重新注入 |
| R7 | React 重渲染恢复 | cue 节点被替换后，下一次 observer flush 自动恢复 |
| R8 | 无重复 | 任意重渲染、搜索、滚动后每个 cue 仍只有一个译文节点 |
| R9 | 不串 cue | 无法可靠匹配的行保持原样，绝不猜测插入 |
| R10 | 支持增量翻译 | pending、已完成、失败状态可在同一 cue 原位更新 |
| R11 | 不越权显示 | 只装饰 Echo360 当前实际渲染并允许用户看到的 cue |
| R12 | Chrome/Safari | 两个平台真实页面通过核心验收用例 |

### 4.2 明确不做

- 不重写或复制一套完整 Transcript panel。
- 不修改 Echo360 下载文件内容。
- 不上传翻译为 Echo360 官方 transcript/captions。
- 不进入 Transcript Editor 页面注入，避免污染可编辑内容和保存结果。
- 不修改 React cue/search/video 业务 props/state、Redux store、Webpack runtime、原生 fetch 或 Echo360 transcript 数据模型。
- 唯一例外是能力探测成功后，由 MAIN-world 小桥可逆地包装现有 List/Grid 的 `rowHeight` 布局 prop，并调用既有的 `recomputeRowHeights()/scrollToRow()`；不得写入宿主业务状态，失败时必须 fail closed。
- 不修改原生搜索输入的 value、原生匹配计数、原生前后按钮状态。
- 不为 Interactive Media 生成未解锁 cue 的可见行。
- 第一阶段不承诺刷新整个页面后自动加载缓存；本需求中的“恢复”指同一页面内关闭/重开 panel。页面刷新自动加载可以单独设计。

---

## 5. 方案比较

| 方案 | 原生功能保留 | 中英文搜索 | 关闭重开 | 对 Echo360 内部耦合 | 结论 |
|---|---:|---:|---:|---:|---|
| 直接替换原 panel | 差 | 可控 | 可控 | 高 | 拒绝；违背核心要求 |
| 修改 React cue/search 业务 props/state | 表面较好 | 可深度集成 | 不稳定 | 极高 | 拒绝；版本更新风险不可接受 |
| 只在 cue DOM 追加中文 | 好 | 英文可靠，中文不一定 | 好 | 低 | 不完整；原生搜索很可能搜索数据模型而非 DOM |
| 独立双语 panel | 原 panel 不变 | 可控 | 可控 | 低 | 拒绝；体验重复且不是“在原 panel 中增强” |
| **DOM 装饰器 + 中文搜索桥 + 布局桥** | **最好** | **可靠** | **可靠** | **低到中、能力受限** | **推荐** |

### 5.1 为什么不假设“追加中文后原生搜索自然可搜”

EchoVideo 实际 bundle 已确认，搜索通过 `searchAllCues(cues, query)` 在 React transcript 数据数组上计算，再把 match pairs 渲染成多个 `span[role="button"]`。扩展追加的中文 DOM 不会进入这个数据数组，因此“只 append 中文”无法满足中文搜索。

推荐方案固定启用独立译文搜索桥；它读取同一个搜索框，但不修改原生查询、计数、按钮或英文高亮。只有将来检测到 Echo 新版本已经原生支持当前 target transcript 时，才可在版本适配层停用重复桥接 UI。

---

## 6. 推荐架构

```text
原始 VTT ─────┐
              ├─ transcript_model：按时间轴对齐 cue，生成双语索引
翻译/partial VTT ┘
                     │
                     ├─ transcript_panel_adapter
                     │    只负责识别 panel、搜索框、cue、滚动容器
                     │
                     ├─ transcript_panel_renderer
                     │    追加/更新中文，处理 React 重渲染和关闭重开
                     │
                     ├─ transcript_search_bridge
                     │    读取同一个原生搜索框，但不拦截原生事件
                     │    只负责中文匹配、高亮、计数和结果定位
                     │
                     └─ transcript_page_bridge（MAIN world，最小能力）
                          扩展现有 List 的 rowHeight 并触发重排
                          调用现有 List.scrollToRow 定位虚拟结果
```

### 6.1 模块职责

#### `extension/transcript_model.js`

职责：

- 将 original VTT 和 translated/partial VTT 转成结构化 cue。
- 用 cue index + start/end 时间进行严格对齐。
- 识别 `ready`、`pending`、`failed` 状态。
- 构建英文和译文的规范化搜索索引。
- 提供重复英文文本的多值索引，不能把文本本身当唯一主键。

建议数据结构：

```js
{
  sessionKey: "<sourceKey>::<configSig>",
  sourceMeta: { sourceId, mediaId, mapSource, stats },
  target: "ZH",
  cues: [
    {
      key: "12500:15800:17",
      index: 17,
      startMs: 12500,
      endMs: 15800,
      originalText: "The original English cue.",
      translatedText: "对应的中文译文。",
      normalizedOriginal: "the original english cue.",
      normalizedTranslation: "对应的中文译文。",
      status: "ready"
    }
  ]
}
```

对齐规则：

1. cue 数量相同且 start/end 差值均不超过 250ms：按 index 对齐。
2. 数量不同：用 start/end 区间匹配，要求 start 差不超过 250ms 且时间区间 overlap ratio 足够高。
3. 一个译文 cue 不得被分配给多个原文 cue。
4. 无唯一匹配时将该 cue 标记为 `unmapped`，不显示译文。
5. partial VTT 中译文与原文规范化后相同，视为 `pending`，显示现有 `正在翻译中...`。
6. 失败预览使用现有 `[翻译失败]`，状态为 `failed`。
7. sessionKey 变化时整体替换模型，防止上一节课译文串入下一节课。

#### `extension/transcript_panel_adapter.js`

职责：只做宿主 DOM 识别，不保存翻译业务状态。

建议接口：

```js
findPanelRoots(document)
findSearchInput(panelRoot)
findScrollContainer(panelRoot)
findCueCandidates(panelRoot)
extractCueText(candidate)
findClickableCue(candidate)
findTranslationMount(candidate)
isViewerPanel(panelRoot)
```

适配原则：

- 优先使用可访问性语义：`role`、`aria-label`、input 类型、button 语义、标题文本。
- 不以 styled-components/hash class 作为唯一 selector。
- new player v1 的已验证 selector 链为：

  ```text
  panel:       #transcripts-panel[role="tabpanel"]
  search:      #search-transcripts_input  (aria-label="Search" 可选)
  list:        .transcript-list[role="grid"]
  rowgroup:    .ReactVirtualized__Grid__innerScrollContainer[role="rowgroup"]
  cue content: dd[data-test-component="Content"][title$=" sec"] | dd[data-test-component="Content"][title$=" min"]
  clickable:   包含完整英文 cue 的 span[role="button"]；搜索拆分时回退共同 Content 容器
  ```

- 真实 viewer DOM 的原生 React click handler 位于完整英文 cue 的 `span[role="button"]`；译文保持为 `dd[data-test-component="Content"]` 的兄弟节点，避免被 React 当作英文 span 的未知子节点清掉。完整 cue 由 guarded proxy 调用该 span；搜索高亮若把英文拆成多个 sibling `span[role="button"]`，`findClickableCue()` 会回退到 Content，不能只返回第一个 span。
- 行 wrapper 通过 `cue content` 向上寻找“具有绝对定位 `top`/`height`、且是 rowgroup 直接子节点”的元素；不依赖 hash class。
- new player 和 legacy classroom 使用独立 adapter，避免一个巨型模糊 selector。当前只对有真实 fixture 的 new player v1 启用；legacy 无证据时诊断为 unsupported，不猜 selector。
- adapter 必须通过由用户样本脱敏得到的 fixture 验证。
- 如果无法确认是 viewer panel，立即退出；任何 `[contenteditable]`、编辑器路由、Replace UI 都视为禁区。
- 同页存在多个 panel 时，只选择与当前 `sourceMeta.mediaId`/主播放器相符的 panel；无法区分时不注入并记录诊断。

#### `extension/transcript_panel_renderer.js`

职责：维护当前 translation model，并把译文幂等地装饰到实际 cue DOM。

公开接口：

```js
start()
setTranslation(model)
setVisible(enabled)
clear()
getDebugState()
```

状态：

```js
{
  model: null,
  documentObserver: null,
  panelObservers: new Map(),
  panelRoots: new Set(),
  cueNodeByKey: new Map(),
  flushScheduled: false,
  ownMutationDepth: 0,
  diagnostics: { ... }
}
```

核心流程：

1. `start()` 在 document 上建立轻量 `MutationObserver`，只关心 child list。
2. 发现 panel 后，为 panel root 建立局部 observer。
3. 每次 flush 只扫描新增 subtree 和当前可见 cue，不反复全页扫描。
4. 提取 cue 原文时排除 `[data-echo360-transcript-translation]`。
5. 用严格文本匹配 + 单调顺序约束映射到 model cue。
6. 在原 `dd[data-test-component="Content"]` 内、所有英文 `span[role="button"]` 之后追加一个扩展拥有的 `<span>`；不把中文塞进 React 管理的英文 span。对完整英文 cue，中文 click 只通过一个受控代理调用该原生 span 的 `.click()`；搜索高亮拆分时回退到 Content 容器的原生冒泡路径。
7. 节点已经存在且 cue key 相同，只更新译文 Text nodes；禁止重复 append。
8. append、文本更新、搜索高亮重建和 remove 后，把对应 row 加入 `layoutMeasureQueue`；同一 animation frame 只请求一次批量重测。
9. 只有布局桥确认该版本可安全重测时才装饰虚拟列表；能力失败时整组 fail closed，避免中文覆盖下一行。
10. panel 被关闭/移除时断开该局部 observer，但保留 model。
11. panel 重新出现时对新 DOM 重新装饰，从而自动恢复。
12. sessionKey 变化或 `clear()` 时，先移除扩展节点和桥接 UI，再请求剩余行缩高，保留所有原生节点。

推荐 DOM：

```html
<dd title="14.14 min" data-test-component="Content">
  <!-- Echo360 原有的一个或多个英文 span，完全不改 -->
  <span role="button">The original English cue.</span>
  <span data-echo360-transcript-translation="1"
        data-echo360-cue-key="12500:15800:17"
        lang="zh-Hans"
        dir="auto">
    对应的中文译文。
  </span>
</dd>
```

样式要求：

```css
[data-echo360-transcript-translation="1"] {
  display: block;
  margin-top: 0.25rem;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: inherit;
  opacity: 0.86;
}
```

- 不修改英文的 font、color、line-height。
- 译文是 `Content` 的扩展子节点，英文 span 的 DOM 与文本完全不变。完整英文 cue 使用只绑定在译文节点上的 guarded click proxy 触发同一个原生 span；搜索拆分/未识别特定 target 时才让事件正常冒泡到 `Content`。
- 不对英文节点调用 `innerHTML`、`textContent=` 或 clone/replace。
- 创建译文只用 `createElement`、`createTextNode`、`textContent`。
- 当前 cue 的原生背景/边框高亮应自然包含译文；扩展不自己同步播放高亮。
- 如果真实页面证明 Echo360 handler 只接受特定 event target，adapter 才允许增加“只作用于译文”的 guarded click fallback；不得全局拦截 cue click。

#### `extension/transcript_page_bridge`（实现落在现有 MAIN-world `page_probe.js` 的窄接口中）

为什么必须存在：

- content script 能共享 DOM，但在 Chrome/Safari 隔离世界里不能可靠访问页面 React 实例。
- Echo 的虚拟列表用原始 `cue.content` 计算 `rowHeight`，并且 row renderer 又把英文高度写入 row inline style。
- 仅调用 `CellMeasurer._measure()` **不够**：它会更新 `CellMeasurerCache`，但当前 Echo `List` 的 `rowHeight` prop 是独立函数 `B(index) -> J(cue.content)`，不是 `cache.rowHeight`。Grid 下一次重排仍会得到旧英文高度。

所以最小可行桥不是修改 cue 数据，而是只扩展布局函数：

1. content world 为每个 model cue 在隐藏测量容器中计算 `translationExtraPx`。测量宽度取当前 `dd[data-test-component="Content"]` 的 content width，字体、line-height、white-space 与正式译文样式一致；实际测量值和 CJK 宽字估算统一保留 8px 额外余量，避免 Safari 在边界换行时低估 row 高度。
2. content world 只向 MAIN world 发送数字映射 `[[cueIndex, extraPx], ...]`、panel token 和 layout revision；不发送 transcript/译文文本。
3. MAIN world 从 `.transcript-list` host DOM 的 React fiber ancestor 找到当前 `react-virtualized List` 实例，必须同时验证：
   - `scrollToRow`、`recomputeRowHeights` 是函数；
   - `props.rowHeight` 是函数；
   - `Grid` 存在且 `Grid.props.rowHeight` 是函数；
   - 请求的 `rowCount` 是完整 model/adapter cue 数的上限；真实 List/Grid 的 `props.rowCount` 必须相等且满足 `0 <= visibleRowCount <= rowCount`。Interactive Media 的 gate 只允许暴露 model 前缀，响应必须返回 `visibleRowCount`；
   - host DOM 确实位于目标 `#transcripts-panel`。
4. 用 `WeakMap` 保存该 List/Grid 实例的原始 `rowHeight`。桥接函数严格为：

   ```js
   function bridgedRowHeight(args) {
     return originalRowHeight(args) + (extraHeightByIndex.get(args.index) || 0);
   }
   ```

   不修改 `cues`、search result、current time、Redux store 或任何业务 props。
5. 同步更新当前 List 与其 inner Grid 的 `rowHeight` 引用后，从最小变更 index 调用 `list.recomputeRowHeights(minIndex)`；新增/删除很多 cue、panel 宽度变化或 target 全量变化时从 0 重排。
6. renderer 给已经确认布局的绝对定位 row wrapper 增加扩展专用 `data-echo360-transcript-decorated-row="1"`。namespace CSS 对该属性设置 `height:auto !important`，让实际 row 内容可以占用桥计算出的空间；清理时只删除这个属性。布局桥接未确认时，译文节点带 `data-echo360-transcript-layout-pending="1"` 作为内部状态标记，但仍保持可见；不得通过 `display:none` 或移出 flow 来掩盖尚未修好的 row 几何。
7. React 重渲染可能重新提供原 `rowHeight`。每次 panel flush/layout revision 都重新做 identity 检查；只有当前值是原函数或本桥函数时才安全重绑。遇到第三方函数、冻结 props、实例结构变化或调用异常，立即撤销该 panel 的装饰并进入 unsupported 状态。
8. `clear()/session change/panel disable` 的顺序必须是：标记 transaction → 删除译文、pending marker 和 decorated-row attribute → extras 清零 → 恢复本桥保存的原函数（仅当当前仍是本桥函数）→ `recomputeRowHeights(0)` → 删除 transaction 状态。

9. 真实 Safari 播放复核发现一个低频竞态：React 提交会先替换/重绘可见 cue，renderer 的 `height:auto !important` 可能在 MAIN bridge 的 `recomputeRowHeights()` 完成前生效。此时当前 row 的真实 bottom 会短暂超过下一 row 的旧 top，表现为中英重叠和 native current-cue 跟随跳动。修复必须遵守以下顺序：
   - panel 的 child-list 变化只有在检测到扩展节点被宿主移除，或当前可测量 row 确实发生几何重叠时才触发布局同步；普通 React child-list 提交不隐藏现有译文，避免把稳定提交误判为不安全。不修改英文 Content、搜索输入或原生事件。panel 宽度变化仍触发布局同步。
   - 新译文先以 pending 状态挂载，仍保留在 DOM 中供中文搜索索引读取，并且从挂载开始就保持可见；pending 只表示 row 尚未完成本轮几何确认，不得改变译文的 display 或 visibility。
   - `set-layout` 成功响应后至少等待一个浏览器帧；随后在同一 JavaScript task 内读取每个可见 row 的 `getBoundingClientRect()`，验证译文 bottom 不超过自身 row bottom，且当前 row bottom 不超过下一 native row top（当前容差 6px，最多连续探测 8 帧）。
   - 探测失败时保留译文和 pending 标记，不隐藏、不删除、不移出 flow；以退避计时器重新发送 row extras 并重新检查几何。只有探测成功才清除 pending 并恢复 decorated-row。
   - 该策略只增加扩展自有节点的布局状态与 row-height 重排，不增加译文可见性闸门；英文原生 DOM、原生搜索、点击跳转、视频时间和 React 业务状态均不变。

通信协议必须是固定 action allowlist，不能接收 selector、函数名或任意脚本：

```js
// content -> MAIN
{
  source: "echo360-translator-transcript",
  version: 1,
  requestId: "opaque-id",
  action: "capabilities" | "set-layout" | "scroll-to-row" | "restore-layout",
  panelToken: "opaque-id",
  revision: 7,
  rowCount: 842,
  extras: [[0, 25], [1, 44]], // 仅 set-layout；全部是有界整数
  rowIndex: 17                // 仅 scroll-to-row
}

// MAIN -> content
{
  source: "echo360-translator-transcript-page",
  version: 1,
  requestId: "opaque-id",
  ok: true,
  capability: "echo-react-virtualized-v1",
  appliedRevision: 7
  visibleRowCount: 842       // MAIN 实际可见的前缀长度，<= rowCount
}
```

边界与限额：

- 只接受 `event.source === window`、同 document、正确 source/version 的消息。
- `rowCount`、`rowIndex`、`extraPx` 必须是有限整数；请求中的 `0 <= rowIndex < visibleRowCount <= rowCount`，`0 <= extraPx <= 400`，单次 extras 最多 10,000 项。extras 可以包含 gate 后索引但 MAIN 只应用 `< visibleRowCount` 的前缀。
- MAIN bridge 不接收 transcript 文本、CSS selector、属性名或可执行内容。
- capability 握手超时、revision 乱序或任一验证失败时，不显示译文；原生 panel 保持原样。
- capability 结果缓存到当前 panel 实例生命周期，不能跨 panel/SPA session 盲目复用。
- `scroll-to-row` 只调用已验证 List 实例的 `scrollToRow(index)`，不 seek 视频、不改变搜索框。

这一层属于有明确版本指纹、可逆、fail-closed 的宿主布局适配，不是通用 React patch。它是满足“完整显示第二行”与“长 transcript 虚拟滚动仍正确”同时成立的必要条件。

### 6.2 cue DOM 映射算法

仅按 DOM 顺序或仅按英文文本都会出错：常见短句如 “Okay.”、“Thank you.” 会重复；搜索时 React 还会把一段英文拆成多个 `<span>/<mark>`。

建议算法：

1. 从 candidate 中复制可读文本，排除：
   - 扩展译文节点；
   - 说话人 label；
   - 时间显示；
   - 搜索计数和按钮文案。
2. Unicode `NFKC` 规范化。
3. 合并 NBSP/空白，保留对语义有影响的标点，统一英文大小写。
4. 用 `normalizedOriginal -> cue[]` 多值索引查 exact candidates。
5. 若 exact 只有一个，直接匹配。
6. 若 exact 重复，使用：
   - 前一个已映射 cue index；
   - DOM 相对顺序；
   - candidate 上可用的时间/data 属性；
   - 当前 viewport 周边 anchor。
7. 只有唯一解时才插入。
8. 允许受控的 near-exact fallback，但必须满足高阈值，并在 diagnostics 记录；默认不启用通用模糊匹配。
9. 映射失败不影响原面板，只记 `unmappedCueRows`。

性能目标：

- 2,000 cue 模型构建 < 50ms（普通桌面浏览器）。
- 单次 observer flush 的 P95 < 8ms。
- panel 关闭时不保留 1 秒级轮询。
- 同一轮大量 mutations 合并到一个 `requestAnimationFrame` flush。

---

## 7. 中文搜索桥设计

### 7.1 不能做的事

- 不阻止原生 input/keydown 事件传播。
- 不调用 React 私有 setter。
- 不向搜索框偷偷写回英文代理词。
- 不隐藏原生“0 个匹配”或伪造原生计数。
- 不接管原生上一个/下一个按钮。

这些做法虽然可能让 UI 看起来“完全原生”，但会改变或破坏英文搜索，且非常依赖 Echo360 当前实现。

### 7.2 推荐交互

仍使用 Echo360 原生的同一个搜索输入框：

1. 扩展在 document capture/bubble 中被动读取 input 值，但不 `preventDefault`、不 `stopPropagation`。
2. 原生 Echo360 先照常计算英文结果。
3. 扩展在下一 microtask/animation frame 计算译文结果。
4. 如果中文有匹配，在原生搜索区域下方追加独立且明确标识的：

   ```text
   译文匹配 2 / 8     ‹  ›
   ```

5. 只在译文行中高亮中文片段；英文下划线仍完全由 Echo360 管理。
6. 查询为空或中文无匹配时移除译文匹配条和译文高亮。
7. Echo 当前 bundle 已确认不会索引扩展 DOM，因此 new-player-v1 始终使用译文匹配条。将来只有在新 adapter 有明确证据时才允许停用它。

这种方式满足“同一个搜索框中英文都能找到”，同时诚实区分 Echo360 原生匹配和扩展译文匹配。

### 7.3 搜索语义

第一阶段采用可预测的本地 substring search：

- 英文：交给 Echo360 原生逻辑。
- 中文：Unicode NFKC 后做 literal substring，不把用户输入当正则表达式。
- 大小写语言：`toLocaleLowerCase()`。
- 结果单位：记录每个实际 occurrence，同时保存其 cue key 和字符范围。
- 混合查询：只要完整 query 在译文中出现，就计为译文结果；不做自动分词或机器同义词扩展。
- 空格：连续空白规范化为单空格。
- HTML：完全按纯文本处理。

### 7.4 高亮安全实现

禁止使用 `innerHTML = translatedText.replace(...)`。

应按匹配 ranges 重建扩展自己的译文 span 子节点：

```html
<span data-echo360-transcript-translation="1">
  普通文本
  <mark data-echo360-transcript-search-hit="1">匹配文本</mark>
  普通文本
</span>
```

所有片段通过 Text nodes 创建，防止字幕文本中的 `<`, `&`, 引号等被解释为 HTML。

### 7.5 上一个/下一个结果定位

点击扩展的前后按钮时：

1. 如果对应 cue row 已在 DOM，调用 `scrollIntoView({ block: "center" })` 并给译文 hit 加临时 current class。
2. 不自动 seek；这与 Echo360 原生搜索箭头“定位结果”、点击 cue“跳转视频”的职责一致。
3. 如果列表虚拟化且目标 row 未渲染：
   - 通过 MAIN bridge 调用已验证 List 实例的 `scrollToRow(cueIndex)`；
   - 等待 observer/最多三个 animation frames 让目标行渲染；
   - 重新映射并精确 scrollIntoView。
4. 不允许按 `cueIndex / cueCount` 猜 `scrollTop`，因为双语行高是动态的，估算会随着译文长度累积漂移。
5. bridge 失败或仍找不到时不猜 DOM、不自动改视频时间，保留结果并记录 `virtualizedTargetMiss`；同时将该 panel 标为 layout capability 异常。

---

## 8. 点击和视频跳转

### 8.1 英文点击

扩展不添加英文 click listener，不替换原生元素。英文点击行为必须与基线完全相同。

### 8.2 中文点击

首选实现是保持 `dd[data-test-component="Content"]` 和英文 `span[role="button"]` 原封不动，把中文作为同一 cue 的兄弟节点。真实 new-player DOM 的原生 React handler 位于完整英文 span，因此中文 click 由译文节点上的 guarded proxy 调用该 span 的 `.click()`；没有完整 target 时才依赖正常 bubbling。这样 Echo360 仍决定正确的视频、iframe、poll gating 和播放状态，同时 React 不会把中文文本并入英文节点。

验收必须比较：

```text
点击英文后的 currentTime
点击同 cue 中文后的 currentTime
绝对差 <= 0.25s
```

如果真实 DOM 证明事件委托依赖特定 target：

- adapter 返回经过验证的 `clickProxyTarget`；
- 只对译文 click 做受控代理；
- 使用 re-entry guard 防止递归；
- 不影响英文事件；
- 该 fallback 必须有专门的单元测试和 Chrome/Safari 实测证据。

禁止第一选择直接设置 `video.currentTime`，因为 Echo360 页面可能有多个 video、独立开场片段、interactive gating 和内部 analytics。只有在确认某种 panel 版本没有任何可复用原生 click target 时，才讨论显式 seek adapter。

---

## 9. 关闭、重开与页面生命周期

### 9.1 同一页面关闭/重开

translation model 保存在 content script 模块内存，而不是保存在 panel DOM 内：

```text
panel close
→ Echo360 删除/隐藏 panel DOM
→ 局部 observer disconnect
→ model 保留
→ panel reopen 创建新 DOM
→ document observer 发现
→ 重新映射并装饰
```

不需要重新请求翻译，也不需要从 storage 再读取一次。

### 9.2 React rerender

- 原生搜索、高亮、当前 cue 更新可能替换英文内部子节点，React 也可能直接移除它不认识的扩展子节点。
- 只要 cue row、mount point 被替换，或 MutationObserver 发现扩展译文被外部移除，observer 都会重新注入；“只移除了扩展节点”不能再被误判为无需处理。
- `data-echo360-cue-key` 只写在扩展节点，不依赖它永久存在。
- own-mutation guard 避免扩展自己的高亮更新触发无限循环。

#### 9.2.1 录屏故障的根因与修复（1.4.3）

录屏中约在第一次 flush 后能看到中英双行，随后虚拟列表发生 React commit，中文消失而英文仍在。根因是两个条件叠加：

1. 译文曾经挂在 React 管理的英文 `span[role="button"]` 内；React reconciliation 会清理它不认识的子节点。
2. 该清理产生的 MutationObserver 记录只包含一个带扩展标记的 removed node，旧逻辑把它判为“扩展自己的 mutation”并直接忽略，因而没有恢复 flush。

1.4.3 的修复是：

- 译文改为 `Content` 的兄弟节点，英文 span 的文本、属性和原生 listener 保持不变；
- 完整 cue 的中文 click 通过只绑定在译文上的 guarded proxy 调用原生英文 span `.click()`；拆分搜索高亮时回退到 Content 冒泡；
- observer 对“外部移除了扩展译文”一律安排幂等恢复 flush；扩展自己的清理最多产生一次空 flush，不会形成循环；
- 增加普通 DOM、虚拟列表握手后 DOM 和自动恢复回归测试。

### 9.3 SPA 切课/换媒体

- 新 `sessionKey` 到达时立即清理旧译文节点。
- 新 model 未准备好前不显示旧译文。
- 如果 URL 变更但 sessionKey 未变，不重复构建。
- 需要测试 Canvas iframe 内跳转和 Echo360 full-tab 两种场景。

### 9.4 页面刷新

当前 controller 只在用户点击“加载翻译字幕”后解析 source 和读取匹配缓存。实现本需求不应顺带扩大为刷新自动加载，以免未经用户请求就启动较重的 source discovery。

若未来要做刷新后自动恢复，应单独增加：

1. 只读 cache 恢复流程；
2. source fingerprint 快速确认；
3. 绝不自动发起付费 Provider 请求；
4. 明确的用户设置。

---

## 10. 与现有翻译生命周期的集成

### 10.1 controller 中增加统一出口

目前 `controller.js` 在缓存命中、增量 preview、最终完成、失败 preview 和偏好切换处多次直接调用 `renderer.renderTranslatedTrack()`。为避免漏掉 Transcript panel，应增加一个 controller 内 helper：

```js
function renderTranslationSurfaces({
  translatedVtt,
  originalVtt,
  prefs,
  sourceMeta,
  target,
  options
}) {
  const videoMounted = ns.renderer.renderTranslatedTrack(/* existing args */);

  ns.transcriptPanel.setTranslation({
    translatedVtt,
    originalVtt,
    sourceMeta,
    target,
    pendingLabel: options?.pendingLabel,
    incremental: !!options?.incremental
  });

  return videoMounted;
}
```

需要覆盖：

- 本地 cache hit；
- 初始全 pending preview；
- 每一批 partial VTT；
- 最终 translated VTT；
- 失败后的 `[翻译失败]` preview；
- retry；
- cancel/clear；
- 字幕偏好变化导致的重新 render。

Transcript panel 是否成功装饰不应改变视频 `<track>` 的 mounted 返回值；两个 surface 独立失败、独立诊断。

### 10.2 原文/译文顺序

Transcript panel 固定为：

```text
Echo360 原文
当前 target 的译文
```

不跟随视频字幕的 `reverseOrder`，因为需求明确要求英文后换行加中文，而且原生英文节点不可移动。

### 10.3 与 `bilingual`/`enabled` 的关系

推荐把 Transcript panel 增强视为独立 surface：

- 视频字幕 `enabled=false` 不自动隐藏 panel 译文。
- 视频字幕 `bilingual=false` 不把 panel 原文移除。
- 新增 `transcriptPanelEnabled`，默认 `true`；用户可以在扩展设置中单独关闭。
- target 跟随当前翻译目标；默认 ZH，因此本需求呈现中文。若用户主动选择 JA/YUE 等，第二行显示相应目标语言。

此产品决定已于 2026-08-24 获用户确认，首版实现按上述行为交付；真实浏览器验收仍按第 14.5 节执行。

---

## 11. 文件级交付与改动记录

下表最初是实现计划；首版代码已按此边界交付。未列出的 legacy adapter 仍保持 fail closed。

| 文件 | 改动 |
|---|---|
| `extension/manifest.json` | 在 `translation_service.js/controller.js` 前注册 Transcript 新模块 |
| `extension/vtt.js` | 增加时间范围解析或提供给 model 使用的稳定接口 |
| `extension/transcript_model.js` | 新增；VTT 对齐、状态、双语搜索索引 |
| `extension/transcript_panel_adapter.js` | 新增；新播放器/legacy DOM 能力适配 |
| `extension/transcript_panel_renderer.js` | 新增；observer、幂等装饰、生命周期、诊断 |
| `extension/transcript_search_bridge.js` | 新增；同输入框中文索引、译文高亮、计数和导航 |
| `extension/page_probe.js` | 增加 allowlist MAIN-world transcript layout bridge；只做 capability、rowHeight、reflow、scroll/restore |
| `extension/controller.js` | 增加统一 render surfaces helper，接入所有翻译状态 |
| `extension/storage.js` | prefs schema 加 `transcriptPanelEnabled`，默认 `true` |
| `extension/ui_popover.js` | 加入独立“增强 Transcript 面板”设置 |
| `extension/ui_styles.js` 或新 renderer style | 添加完全 namespace 的宿主 panel 样式 |
| `tests/helpers/load-module.js` | 注册新模块的 namespace/test loader |
| `tests/unit/transcript_model.test.js` | 新增 model/alignment/search 测试 |
| `tests/unit/transcript_panel_adapter.test.js` | 新增真实脱敏 DOM fixtures 适配测试 |
| `tests/unit/transcript_panel_renderer.test.js` | 新增注入、幂等、重建、点击测试 |
| `tests/unit/transcript_search_bridge.test.js` | 新增中文查询、高亮、导航、原生不干扰测试 |
| `tests/unit/transcript_page_bridge.test.js` | 新增握手、输入验证、rowHeight 扩展、重排、滚动、恢复、fail-closed 测试 |
| `tests/fixtures/transcript-panel/*` | 从真实页面脱敏得到 new/legacy/search/virtualized fixtures |

不要把 Transcript panel 逻辑塞入已有 `bilingual_dom_renderer.js`。它只负责播放器当前 CC overlay；Transcript panel 是完整 cue 列表、搜索和 panel 生命周期，职责与性能模型不同。

---

## 12. 诊断和可维护性

`getDebugState()` 至少返回：

```js
{
  active: true,
  sessionKey: "...",
  target: "ZH",
  modelCueCount: 842,
  modelOriginalCueCount: 842,
  modelTranslatedCueCount: 842,
  modelMappedCueCount: 842,
  modelUnmappedCueCount: 0,
  panelCount: 1,
  discoveredCueRows: 54,
  decoratedCueRows: 54,
  unmappedCueRows: 0,
  duplicateTextResolutions: 3,
  searchQuery: "机器学习",
  translatedMatchCount: 8,
  nativeSearchMode: "echo-cue-model",
  observerFlushCount: 27,
  lastFlushDurationMs: 1.8,
  maxFlushDurationMs: 5.4,
  virtualizedTargetMisses: 0,
  layoutCapability: "echo-react-virtualized-v1",
  layoutRevision: 7,
  layoutExtraRowCount: 842,
  layoutBridgeFailures: 0,
  lastLayoutFailure: null,
  rawPanelCount: 1,
  rawListCount: 1,
  rawSearchInputCount: 1,
  verifiedPanelCount: 1,
  lastBridgeAction: "set-layout",
  lastBridgeResult: "echo-react-virtualized-v1",
  lastBridgeElapsedMs: 2.1,
  panelStates: [{
    virtualized: true,
    modelRowCount: 842,
    visibleRowCount: 842,
    layout: "ready"
  }],
  adapter: "new-player-v1"
}
```

日志策略：

- 正常 cue 不逐条 `console.log`。
- adapter 不能识别、映射比例过低、多个 panel 无法区分、layout capability 失败时 `console.warn` 一次。
- diagnostics 可由 `window.Echo360Translator.transcriptPanelRenderer.getDebugState()` 主动读取；同时会发布到当前 frame 的 `<meta name="echo360-translator-transcript-panel-debug">`，便于 Safari/Canvas iframe 现场复制 JSON。
- MAIN bridge 对有效但无法验证的请求返回不含 transcript 文本的错误码，例如 `react-fiber-not-found`、`host-row-count-exceeds-model`、`row-manager-getter-mismatch` 或 `props-frozen`；真正没有响应时记录 `timeout`。
- 不记录 API Key。
- 默认不把完整 transcript/译文输出到 console，避免隐私泄露。

建议安全阈值：

- panel 中至少 80% 的可识别英文 cue 能 exact/ordered match 才启用批量装饰。
- 低于阈值时停止装饰并显示扩展侧状态提示“Transcript panel 结构暂不兼容”，不能继续猜。
- 已经唯一 exact match 的个别 cue 可以保留，但不得进行低可信 fuzzy 注入。

---

## 13. 安全、隐私与无障碍

### 13.1 安全

- 译文一律按文本节点插入，杜绝字幕内容触发 HTML/XSS。
- 不使用 `eval`、不注入 inline executable script。
- 不读取或修改 React/Redux 业务 state，不修改 cue 数据。
- MAIN bridge 只通过 React host fiber 定位 `react-virtualized` List/Grid 实例，保存/恢复 `rowHeight` 函数引用并调用其现有布局方法；接口固定、可逆、版本受限。
- `window.postMessage` 消息必须经过 source/version/action/类型/范围/revision 校验，不接受文本或任意 selector。
- 不新增网络权限。
- 不新增远程请求；使用已有翻译结果。
- 清理时只删除带扩展专用 data attribute 的节点。

### 13.2 隐私

- Transcript panel 功能不产生新的翻译上传。
- DOM 中显示的译文理论上可被页面脚本读取；这是任何页面 DOM 增强都不可避免的边界，应在隐私说明中注明。
- diagnostics 不输出完整 cue 文本。

### 13.3 无障碍

- 译文设置正确 `lang`：`ZH -> zh-Hans`、`ZH-HK/YUE -> zh-Hant`、`JA -> ja`、`EN -> en`。
- 继承原 cue 的 clickable/focus 语义，不创建嵌套 button。
- 译文搜索前后按钮必须有中文和英文可理解的 `aria-label`。
- 当前译文搜索结果使用 `aria-current="true"` 或状态文本，但避免抢走原搜索框 focus。
- 不用颜色作为唯一结果标识；同时使用 `<mark>` 和当前结果 outline。
- 缩放 200% 时不横向溢出。

---

## 14. 测试计划

### 14.1 model 单元测试

1. original/translated 数量和时间完全一致。
2. 250ms 内时间误差可对齐。
3. 超阈值不对齐。
4. cue 数量不一致时按时间区间唯一匹配。
5. 重复英文不使用文本作为唯一主键。
6. partial VTT 原文回填识别为 pending。
7. `[翻译失败]` 状态。
8. HTML-like 字幕作为纯文本。
9. CRLF、NBSP、NFKC、组合字符、emoji。
10. 中文 literal substring 和多 occurrence ranges。

### 14.2 adapter/renderer DOM 测试

1. new player fixture 能识别 panel/search/cues/scroll container。
2. legacy/未知结构 fixture 在没有真实 adapter 证据时 fail closed。
3. Transcript Editor fixture 必须拒绝。
4. 搜索 `<mark>` 拆分英文后仍能提取完整原文。
5. speaker label 不进入 cue 原文。
6. 首次注入一行中文。
7. 重复 flush 不重复。
8. React 替换 cue child、直接移除扩展译文后自动恢复。
9. panel remove/re-add 后自动恢复。
10. model sessionKey 变化清除旧译文。
11. unmapped row 保持原样。
12. incremental update 原位更新，不新建第二行。
13. 扩展 own mutations 不形成 observer loop。
14. 点击中文通过 guarded proxy 触发与英文相同的 native handler，且英文节点没有新增 listener 或文本修改。
15. fixture 中能识别绝对定位 row wrapper 与 `sec|min` `title`（包含 `0.00 sec`、`59.99 sec`、`1.00 min`），并将其转换为时间消歧提示。
16. 装饰 row 增加专用 attribute，清理时只移除扩展节点/attribute。
17. 译文长度变化、panel width 变化后重新生成 `translationExtraPx`。

### 14.3 MAIN-world 布局桥测试

1. capability 只接受真实 panel 内、具有预期 List/Grid 方法、Grid `rowSizeAndPositionManager` 以及 rowCount 的实例；manager 的 `cellSizeGetter` 必须与当前 Grid `props.rowHeight` 指纹一致。
2. 不认识的 React fiber key、冻结 props、缺少 Grid/manager、List 与 Grid 的可见 rowCount 不一致或 `visibleRowCount > modelRowCount` 时 fail closed；host gate 从 3 行增长到 5 行时允许重新验证并更新前缀。
3. `set-layout` 使 `rowHeight({ index }) === originalHeight + extraPx`，未配置行仍等于 originalHeight。
4. revision 只允许单调递增；迟到响应/旧 revision 不覆盖新布局。
5. 多行变化只从最小 index 调用一次 `recomputeRowHeights`。
6. `scroll-to-row` 只调用 `List.scrollToRow`，不调用 video seek。
7. `restore-layout` 只在当前函数仍是本桥函数时恢复原引用，随后从 0 重排。
8. 第三方已替换 rowHeight 时不覆盖对方函数。
9. message 不能携带任意 selector/function；非法 action、NaN、负数、越界 index、超长 extras 全部拒绝。
10. panel remove 后 WeakMap 状态可回收；新 panel 必须重新握手。

### 14.4 搜索桥测试

1. 英文输入时不调用 preventDefault/stopPropagation，不修改 input.value。
2. 英文原生计数/按钮 DOM 不被扩展修改。
3. 中文查询显示正确 occurrence count。
4. 中文查询仅高亮译文节点。
5. 查询清空移除扩展高亮和计数条。
6. `.*[]()<>` 等按字面搜索，不作为 regex/HTML。
7. 上一个/下一个循环策略明确并测试。
8. 定位结果不自动 seek。
9. 点击定位后的译文才 seek。
10. panel 重开后读取当前 input 值并恢复查询状态。
11. new-player-v1 即使原生显示 0 results，译文匹配条仍正确显示；不隐藏或改写原生 0。

### 14.5 真实页面手工矩阵

| 场景 | Chrome | Safari |
|---|---:|---:|
| 新播放器 full-tab | 必测 | 必测 |
| Canvas/LMS iframe 后展开 | 必测 | 必测 |
| legacy classroom（取得真实样本后） | 暂不启用 | 暂不启用 |
| Transcript-only、无原生 CC | 必测 | 必测 |
| 有 Transcript + 有 CC | 必测 | 必测 |
| 单/双视频 | 必测 | 必测 |
| 暂停、播放、seek、2x | 必测 | 必测 |
| 英文搜索 0/1/多结果 | 必测 | 必测 |
| 中文搜索 0/1/多结果 | 必测 | 必测 |
| 关闭/重开 panel 10 次 | 必测 | 必测 |
| 2 小时长 transcript | 必测 | 最好测 |
| Interactive Media poll gating | 必测 | 最好测 |
| 200% zoom、深色模式 | 必测 | 必测 |
| 短/长/多行中文与连续快速滚动 | 必测 | 必测 |
| panel 宽度变化后总高度/定位重算 | 必测 | 必测 |

每次手工测试要记录：页面类型、Echo360 host、浏览器版本、adapter 名、model cue 数、decorated/unmapped 数和 debug state；不记录完整 transcript。

### 14.6 回归命令

```bash
npm test
npm run build
git diff --check
```

历史基线的 14 files/295 tests 必须继续作为回归参考；当前首版已扩展为 21 files/350 tests，全部通过。store/dev build、Safari 资源核对和 `git diff --check` 也已通过；真实 Safari/Chrome 手工矩阵仍待验收。

### 14.7 Safari Xcode 资源核对

Safari 手工验收前，必须确认“当前源代码、manifest、Xcode bundle”是同一版本。推荐顺序：

1. 在仓库根目录运行 `npm run build:store`，得到 `dist/extension-store/`。
2. 如果使用新工程，使用 `xcrun safari-web-extension-packager` 重新生成/重建 Xcode 工程；如果继续使用旧工程，在 Xcode Project Navigator 的两个 Extension targets 中确认 Resources 同时包含：
   `transcript_model.js`、`transcript_panel_adapter.js`、`transcript_search_bridge.js`、`transcript_panel_renderer.js`。
3. 确认 Safari bundle 内的 `manifest.json` 版本为 `1.4.3`，且 manifest 的第二个 `content_scripts[].js` 列表包含上述 4 个文件。
4. 在 Xcode 中停止旧运行实例，Clean/Build 当前 macOS App，重新启用 Safari 扩展；关闭旧 Canvas/EchoVideo tab 后重新打开。
5. 确认扩展 popover 的“增强 Transcript 面板”已开启，再点击一次“加载翻译字幕”。

只运行 `npm run build` 不会自动重建已经安装在 Safari 中的 App；Apple 的 Safari Web Extension 更新流程要求由 Xcode 重新构建并打包资源：[Updating a Safari web extension](https://developer.apple.com/documentation/safariservices/updating-a-safari-web-extension?language=objc)。

---

## 15. 分阶段实施顺序

### Phase 0：真实 DOM 与播放器实现取证（已完成）

交付物：

- 已取得 Canvas 外层和 EchoVideo iframe 内部 HTML。
- 已确认 panel/search/cue/clickable/list/rowgroup 的稳定语义。
- 已确认 React 搜索基于 transcript 数据模型。
- 已确认 `react-virtualized`、绝对定位、动态原文高度、缓存与 `scrollToRow`。
- 已确认 Safari Canvas LTI 是首要验收场景。

退出条件已满足：可以用稳定语义写 new-player-v1 adapter fixture，不依赖 hash class。legacy 没有真实样本，首版明确 fail closed，不阻塞 new player 实现。

### Phase 1：纯 model 和 fixture adapter（代码已完成）

- 已实现 VTT 时间解析、model 对齐、搜索 index。
- 已从脱敏 DOM 建立 new-player-v1/search/legacy fail-closed fixtures。
- model/adapter 单元测试已通过。

代码退出条件已满足：重复 cue、搜索 mark、speaker label、编辑器拒绝全部有测试。

### Phase 2：只读 DOM 装饰器（代码已完成，真实页面待验收）

- 已注入静态译文行。
- 已完成 MAIN layout bridge、幂等、observer、close/reopen、session clear。
- MAIN manager getter、row offset、gate visible prefix、React rebind/restore 均有单元测试。

代码退出条件已满足；真实页面仍待扩展安装后验证英文/中文点击、当前 cue、高度、快速滚动和关闭重开。

### Phase 3：中文搜索桥（代码已完成，真实页面待验收）

- 已被动监听同一 input。
- 已实现中文 occurrence、高亮、计数、前后定位。
- 已通过 List.scrollToRow 定位未渲染结果，并按 visibleRowCount 过滤 gate 后 cue。

代码退出条件已满足：英文原生搜索 DOM 回归无变化；中文 0/1/多结果已有自动化测试。真实页面仍待验收。

### Phase 4：controller 增量/缓存集成（代码已完成）

- 已统一 render surfaces helper。
- 已接入 cache、partial、final、failed、retry、cancel。
- 已加入确认的独立 prefs 开关，默认开启，并覆盖 panel disabled 早退。

代码退出条件已满足：所有翻译状态的自动化回归通过，无重复、无串课证据。

### Phase 5：跨浏览器和长 transcript 验证（待真实页面验收）

- 待在 Chrome + Safari 手工执行。
- 待验证 new-player-v1 的 full-tab/Canvas iframe/transcript-only；legacy 取得真实样本后另开 adapter。
- 待记录真实页面性能和诊断阈值。
- README、README.en、PRIVACY 是否需要更新，留在真实验收后决定。

退出条件尚未满足：需完成第 14.5 节矩阵并据此复核第 17 节标准。

---

## 16. 实现输入与决定状态

### Q1（已解决）：Echo360 iframe 内的真实 Transcript panel DOM

用户提供的第二份 HTML 已包含加载完成后的 EchoVideo iframe 内部 DOM。它覆盖 panel root、搜索框、清除/下载按钮、虚拟列表、rowgroup、绝对定位 row、cue Content、点击 span 和当前 cue 状态；播放器 bundle 又补足了搜索数据流、行高函数、cache 和虚拟滚动 API。

结论：实现所需输入已经足够，没有剩余的技术阻塞问题。首版只承诺有真实证据的 `new-player-v1`；legacy adapter 在没有 fixture 时必须 fail closed，而不是臆测。

### Q2（已确认）：panel 译文独立于视频字幕开关

已确认采用：

- `Transcript panel 增强` 独立开关，默认开启；
- 关闭视频字幕不隐藏 panel 译文；
- 关闭双语视频字幕不影响 panel 的“英文 + 译文”；
- 译文语言跟随当前 target，默认中文。

用户已接受这一行为，不再是实现阻塞项。

### Q3（已由“不改变原生功能”约束确定）：虚拟列表兼容策略

采用第 6 节的可逆 layout bridge：不修改 cue/search/video 业务数据，只扩展 List/Grid rowHeight、触发重排并调用 `scrollToRow`。如果版本指纹或恢复条件不成立，则不显示译文并保留原 panel，不采用覆盖、估算滚动或替换 panel 的降级方式。

### 实现交付清单与已知待验收项

首版代码交付物如下：

- 核心实现：`extension/vtt.js`、`extension/transcript_model.js`、`extension/transcript_panel_adapter.js`、`extension/transcript_panel_renderer.js`、`extension/transcript_search_bridge.js`。
- 宿主桥与生命周期：`extension/page_probe.js`、`extension/controller.js`、`extension/storage.js`、`extension/ui_popover.js`、`extension/manifest.json`。
- Safari 交付核对：`scripts/verify-safari-xcode-resources.mjs`，检查 manifest 中所有 content-script 文件是否同时存在于 Xcode 两个 Extension targets 的 Resources。
- 自动化验证：`tests/unit/transcript_model.test.js`、`tests/unit/transcript_panel_adapter.test.js`、`tests/unit/transcript_panel_renderer.test.js`、`tests/unit/transcript_search_bridge.test.js`、`tests/unit/transcript_page_bridge.test.js`，以及 controller/storage/UI 回归测试。
- 脱敏输入：`tests/fixtures/transcript-panel/new-player-v1.html`、`search-split.html`、`legacy-unknown.html`。
- 当前自动化状态：21 个 test files、350 个 tests 全部通过；store/dev build、Safari 资源核对和 `git diff --check` 均通过。

已知待验收项：

- 尚未在真实登录后的 Safari/Chrome 页面执行第 14.5 节手工矩阵，尤其是 Canvas/LMS iframe、full-tab、Transcript-only、2 小时长 transcript、200% zoom 和深色模式。
- 需要实测真实 EchoVideo 版本的 React fiber、Grid manager getter identity、中文/英文点击、当前 cue 高亮、快速虚拟滚动、panel 关闭重开及宽度变化后的总高度。
- 需要实测 Interactive Media poll gating 的 visible rowCount 从 3 到 5 的恢复，以及 gate 后中文搜索不会计数或定位。
- 需要记录真实浏览器的 flush P95、manager offset/inner total height 和 Safari/Chrome 差异；legacy classroom 在取得真实 fixture 前继续 fail closed。

---

## 17. 最终验收标准

代码首版已经完成；产品功能只有在以下代码条件与真实页面条件全部满足时，才可标记为最终验收完成。当前第 11、12、15、16 项仍需要真实 Safari/Chrome 页面证据：

1. 同一页面加载翻译后，至少 99% 可唯一映射的已渲染 cue 出现正确译文；其余 cue 不误配。
2. 每个 cue 最多一个扩展译文节点。
3. 英文点击与改造前行为一致。
4. 中文点击和同 cue 英文点击的目标时间差不超过 250ms。
5. 英文搜索的原生 count、highlight、next/previous 和清除行为不受影响。
6. 中文查询可获得正确 count、highlight、previous/next 定位。
7. panel 连续关闭/打开 10 次，无须重新翻译，译文每次自动恢复且无重复。
8. 搜索、播放高亮、窗口 resize、full-width 切换、React rerender 后译文仍在正确 cue。
9. Interactive Media 未解锁的 cue 不会被扩展提前显示。
10. Transcript Editor 不注入。
11. Chrome 与 Safari 核心矩阵通过（当前待手工验收）。
12. observer P95 flush 小于 8ms，不存在持续全页高频扫描。
13. 历史基线 14 files/295 tests 保持通过，当前 21 files/350 tests 和全部新增 tests 通过。
14. store/dev 构建通过，`git diff --check` 通过。
15. 所有已装饰行的实际高度不小于内容 `scrollHeight`，相邻绝对定位 row 的 `top` 不发生覆盖。
16. 加/删译文、改变 target、panel resize 后 inner scroll container 总高度与 `rowHeight` 重算一致。
17. layout bridge 不兼容时 fail closed，原生 panel 的搜索、滚动、点击和下载仍可使用。

---

## 18. 最终推荐

采用“**原生 cue DOM 无损装饰器 + 同搜索框的中文搜索桥 + 可逆虚拟列表布局桥**”。

这个方案的核心不是让扩展看起来像接管了 Echo360，而是让 Echo360 继续拥有它擅长的部分：英文搜索、当前 cue、高亮、视频跳转、poll gating 与虚拟列表生命周期；扩展只拥有自己新增的部分：译文文本、译文索引、中文高亮、译文所需额外行高和生命周期恢复。

它不修改 transcript 数据模型，比复制整个 panel 更符合“不改变原生功能”，也比单纯追加 DOM 更能可靠满足中文搜索和虚拟行高。真实 DOM 与播放器 bundle 取证已经完成，首版代码和自动化测试也已交付；但真实 Safari/Chrome 登录页面的手工矩阵尚未完成，因此当前应标记为“代码完成、浏览器待验收”，而不是全功能最终验收完成。若 Echo 版本不符合已验证结构，正确行为是 fail closed，而不是猜测。
