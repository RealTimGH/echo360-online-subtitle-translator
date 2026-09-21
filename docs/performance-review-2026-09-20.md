# 性能审查与修复记录（2026-09-20）

审查基线：`80245a832540b0a335d742a9d1589e4f24a65323`。范围包括浏览器扩展的页面探测、字幕渲染、搜索、翻译与存储链路，Python 后端与翻译器，macOS 后端启动器，以及构建和测试脚本。

本次对已确认的中等及以上问题进行了修复。严重程度根据触发频率、输入规模、资源是否有界和对播放主线程的影响评估；不是生产环境事故等级。没有在登录后的真实课程、不同浏览器或长时间 Argos 推理负载下测量整机功耗，因此不能据此保证所有设备都不发热，也不能保证静态审查发现了所有运行时瓶颈。

## 已处理的问题

| 级别 | 问题与影响 | 修复方法 |
| --- | --- | --- |
| 高 | 播放器字幕在视频帧回调中反复生成相同 DOM、写样式和读取布局，持续占用主线程 | 缓存当前字幕与样式；同一字幕不重复替换节点；仅在字幕变化、尺寸或相关 DOM 变化时刷新；保留低频几何校验以兼容播放器自身布局变化；隐藏后取消帧回调，恢复时立即刷新 |
| 高 | 原文与译文数量不同时，对齐算法反复全量交叉比较，长字幕可阻塞 UI | 建立时间排序索引、二分限定候选区间；双向唯一匹配保持原有歧义处理语义；候选计数超过一后提前停止，避免密集时间戳生成巨大候选集合 |
| 高 | React 内部对象探测和 Shadow DOM 遍历反复运行，宽对象图可消耗大量 CPU | 使用有总访问预算的图遍历、短期 WeakMap 缓存与源属性失效；移除数组头部反复删除；页面探测改为事件合并及按需刷新 |
| 高 | 后端 VTT 扫描反复复制剩余行，形成平方级 CPU/临时内存开销 | 单次遍历识别时序字幕与统计信息，避免 suffix slicing 和重复解析 |
| 高 | 每个翻译批次都重建、写出完整部分 VTT，长任务产生平方级磁盘写入 | 长字幕的完整进度快照按完成比例合并为约 20 次，最终状态强制输出；数字进度仍持续更新 |
| 中 | 定时同步可重叠，隐藏页面继续扫描和读取设置，失败预取反复请求 | 改为本轮完成后再调度；缓存设置并通过 storage.onChanged 失效；页面隐藏暂停、恢复重启，保留标准画中画场景；自动预取限次并退避 |
| 中 | 同一源解析过程反复请求相同字幕 URL | 仅在该次解析内共享在途请求及短期结果；32 条、总字符预算和 2 秒到期限制；后续独立解析不会复用旧课程结果 |
| 中 | 搜索反复归一化字幕、按 key 线性查找，面板更新触发无关扫描 | WeakMap 缓存归一化结果，文本改变自动失效；cue key 索引；合并刷新，限定观察范围，过滤自身 DOM 更新和无关事件 |
| 中 | 字幕 Blob URL、旧视频状态及观察器生命周期不完整 | 释放被替换/过期的 URL 和脱离页面的视频状态；停止无用观察；字幕文本与样式保持不变时跳过写入 |
| 中 | 翻译进度轮询重复传输多 MB 的未改变部分 VTT | 前后端增加 partial_revision；客户端携带已见版本，服务端省略不变的正文；旧客户端仍可获取完整响应 |
| 中 | 大量终态任务与后端磁盘缓存按条目计数仍可能占用过大空间 | 增加累计结果大小预算、缓存字节预算与过期清理；完成后清除重复部分结果；优先清理旧终态任务，不删除活跃任务 |
| 中 | 缓存命中反复写完整 storage.local，异步读改写竞争 | 缓存使用时间按分钟合并更新；串行化缓存变更；减少设置持久化和进度写入的重复工作 |
| 中 | 手动翻译分块反复 indexOf/findIndex，逐条 splice 重建长 VTT | 为记录和路径建立索引；顺序重建 VTT；进度显示不再构造完整导出包；仅合并在途相同检查点写入并保留可重试语义 |
| 中 | 翻译器预先提交全部 futures、HTTP 连接重复建立、Argos 模型重复查找 | 在途 futures 限于 worker 数；每线程复用 Requests Session；有界缓存 Argos 模型解析 |
| 中 | 错误详情、日志和递归诊断对象放大内存/序列化开销 | 限定详情样本、字符串长度、对象深度及全局访问预算；保留完整失败数量与失败字幕定位，不以截断后的详情数量代替总数 |
| 高（审查回归） | 详情采样后，最终渲染只读取最多 50 条 `failed_items`，第 51 条及之后失败字幕不会被标为失败 | 渲染、预览和摘要改为合并完整的 `failed_cues`；Python 翻译器、后端任务结果和客户端校验都保留该定位列表；`failed_items` 仍只作为诊断样本 |
| 中（审查遗漏） | Echo360 原生字幕注入在字幕隐藏后仍按视频帧回调扫描播放器 | 隐藏时取消 `requestVideoFrameCallback`，显示时立即恢复；已穷尽且无锚点的 cue 不再每帧全树查询 |
| 中 | macOS 管道输出为每个数据块排队刷新整段文本，大量日志拖慢 UI | 合并主线程刷新和管道 drain；队列、未换行文本和单行按 UTF-8 字节限额，保留最近 500 行；结束时清空已排队输出 |
| 中（开发流程） | 普通单测也进行覆盖率插桩，语法检查进入虚拟环境 | 仅在显式覆盖率模式插桩，缓存编译后的测试模块；排除依赖/缓存目录；保留原覆盖率阈值 |

## 资源策略与取舍

- 自动源预取失败最多尝试 3 次，后续间隔递增；用户主动重试不受该自动次数限制。
- 源请求缓存限定在单次解析内，最多 32 项、8 Mi 字符；字符串的实际内存占用与引擎有关，不等于固定字节数。
- 扩展终态任务正文预算为 24,000,000 字符；后端终态结果字符串预算为 256 MiB。为保证刚完成的结果能被轮询取得，保留最新终态任务；活跃任务也不会被内存回收取消，因此这些是保留策略预算，不是整个进程的硬内存上限。
- 后端磁盘翻译缓存：7 天过期、最多 256 个文件、累计 512 MiB；读取前拒绝大于 64 MiB 的单文件。保留现有缓存 schema 和 key，避免升级造成全部缓存失效并重新翻译。
- macOS 日志：待处理队列 1 MiB、未完成行 64 KiB、展示单行 16 KiB、最近 500 行。高吞吐时丢弃较旧日志文本，字幕和翻译结果不受影响。
- 完整部分字幕快照减少后，长任务的可见字幕预览粒度可能变粗；数字进度和最终结果保持更新。这一取舍避免按每个小批次重写完整文件。
- 保留必要的低频回退检查，以兼容播放器节点替换、异步插入原字幕与布局变化；没有将所有扫描简单关闭。

## 可复现基准

运行：

```sh
node scripts/benchmark-performance.mjs --baseline=80245a832540b0a335d742a9d1589e4f24a65323
```

脚本从 Git 读取基线模块，与工作区模块分别执行同一输入；不修改工作区。输入为 2,000 条原字幕、缺少一条的译文，触发非等长对齐路径。先验证输出的 key、文本和匹配状态一致，再预热并执行 5 次，取中位数。

本机 Node v24.16.0 的一次测量：基线 **289.30 ms**，修复后 **20.27 ms**，约 **14.27 倍**。这是特定算法和合成输入的结果，存在机器与运行波动，不代表整体应用、CPU 使用率、功耗或温度也改善相同比例。时间窗口内大量不重叠的异常候选仍可能使搜索退化；本次未宣称所有输入的复杂度均为线性。

播放器回归测试另外验证：100 次时间不变的视频帧不会重复替换字幕 DOM 或读取几何布局；跨字幕边界仍立即更新；隐藏/恢复及原生字幕可见性变化仍正确响应。

## 验证方法

最终验证结果：

- JavaScript：36 个测试文件、693 项测试全部通过。
- Python：63 项测试全部通过，运行环境 Python 3.13.9，依赖版本与 requirements.txt 一致。
- 覆盖率：语句 70.66%、分支 57.50%、函数 73.95%、行 73.61%，通过项目原有阈值。background.js 的 VM 执行未被现有覆盖率收集方式统计，整体覆盖率不等于每个文件均获得完整验证。
- Swift 启动器类型检查通过。
- 语法检查：52 个 JavaScript 文件、6 个 Python 文件通过；扩展结构的 64 个引用、14 份 Markdown 文档检查通过。
- Store 和 Dev 扩展构建成功，输出 dist/extension-store、dist/extension-dev 及对应 ZIP。
- Safari：资源同步完成；50 个生成文件、两个扩展 target 中的 47 个顶层资源检查通过。这是资源一致性检查，没有执行 Safari GUI 播放或 Xcode 签名发布。
- git diff --check 通过。

```sh
npm test -- --maxWorkers=2
npm run test:coverage -- --maxWorkers=2
ECHO360_TEST_PYTHON=/tmp/echo360-test-venv/bin/python npm run test:python
swiftc -module-cache-path /tmp/echo360-swift-module-cache -typecheck backend/macos_app.swift
npm run check:syntax
npm run check:structure
npm run check:docs
npm run build
npm run safari:sync
npm run check:safari
git diff --check
```

Python 测试使用安装了 backend/requirements.txt 精确版本的临时环境；复现时可使用自己的 Python 3.10+ 环境设置 ECHO360_TEST_PYTHON，或安装到 backend/.venv。未降低测试和覆盖率门槛来取得通过。

## 官方资料与方案依据

- MDN 建议耗时可能超过间隔的轮询在本轮完成后递归 setTimeout，避免重叠请求：[setInterval](https://developer.mozilla.org/en-US/docs/Web/API/Window/setInterval)。页面不可见时减少后台工作参考 [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)。
- 缓存设置并通过变更事件同步使用 Chrome 官方 [storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)。
- 减少无效 DOM 写入、布局读写交错和大范围布局工作参考 [web.dev 布局抖动指导](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)；观察范围和生命周期参考 MDN [observe](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe) 与 [disconnect](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/disconnect)。
- 对象缓存采用 [WeakMap](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap)，避免缓存本身持有已废弃字幕模型/视频节点。
- 有界任务提交参考 Python [concurrent.futures](https://docs.python.org/3.13/library/concurrent.futures.html)；连接复用参考 Requests 官方 [Session 与连接池说明](https://requests.readthedocs.io/en/stable/user/advanced/)。
- 本地翻译的线程与并行策略参考 CTranslate2 [性能指导](https://opennmt.net/CTranslate2/performance.html) 和 [并行执行指导](https://opennmt.net/CTranslate2/parallel.html)；没有盲目提高线程数，以免 CPU 过度订阅。
- macOS 异步读取和主线程调度参考 Apple [FileHandle.readabilityHandler](https://developer.apple.com/documentation/foundation/filehandle/readabilityhandler) 与 [DispatchQueue](https://developer.apple.com/documentation/dispatch/dispatchqueue/)。
- 开发时按需启用覆盖率参考 Vitest [Coverage](https://vitest.dev/guide/coverage)。

本次采用的是适合现有架构的事件合并、增量更新、有界缓存/队列和连接复用；这些具体阈值由项目负载和兼容性需求选择，不是官方规定的通用最优数值。

## 独立复查（同日）

复查目标：确认上述优化是否真正消除对应热点、方案是否正确，以及是否仍有中等及以上遗漏。复查对照当前工作区与基线 `80245a8`，并复跑回归测试。

**结论：第一轮优化在轮询、缓存、对齐、渲染跳过和后端资源上限上是有效且方向正确的；但“详情采样”与“完整失败定位”在端到端渲染路径上没有接上。** 这一缺口已在复查中修复。

| 判定 | 说明 |
| --- | --- |
| 方案合理 | 重叠轮询改为完成后调度、`storage.onChanged` 缓存偏好、部分 VTT 用版本号省略、连接复用、有界缓存/日志，符合 MDN / Chrome Storage / Requests Session / `cancelVideoFrameCallback` 的常规做法 |
| 实测有效 | 不等长对齐基准可复现约 14 倍加速；稳定字幕连续视频帧不再重建 DOM |
| 已修复的原有遗漏 | 61 条字幕中 60 条失败时，翻译结果含完整 `failed_cues`，但最终渲染原先只收到前 50 个。现已合并完整定位列表，并补上 Python/后端/客户端传递 |
| 已补上的遗漏 | `bilingual_dom_renderer` 是原生 CC 注入路径，第一轮只优化了 Instructure overlay 和 Echo overlay；隐藏后仍按帧回调。现已取消隐藏时的帧回调 |
| 刻意保留 | 原生字幕注入在未匹配的 750ms 宽限期内仍可能全树扫描播放器，这是为了跟上看不见的宿主字幕刷新；已有粘性锚点和 33ms 节流。转录面板开启时仍观察 `document` 以发现新面板，关闭时断开 |
| 未声称已解决 | 未做登录后长时间播放、整机温度/功耗或 Safari GUI 测量。14 倍是特定对齐算法的结果，不能等同整机 CPU 或发热同比例下降 |

复查新增回归：采样后的失败字幕仍全部标记；隐藏原生注入会取消视频帧回调。


## 后续定向修复

- Echo overlay 的交互布局刷新由连续 rAF 改为最多约 10Hz 的定时合并；保留 900ms 的动画跟随窗口，字幕变化立即渲染。无关播放器 mutation 不再同步触发布局渲染。隐藏、卸载时取消定时器。
- 转录面板的文档观察器仅对涉及面板、列表、搜索框等相关节点的增删触发发现；内容更新由面板观察器处理，内容刷新不重复全页发现及诊断查询。保留面板关闭、重新打开和替换时的发现能力。
- 原生 CC 注入隐藏时一次性清理注入，后续 timeupdate 和 mutation 直接退出；显示时重新匹配当前 cue，隐藏期间不计作宿主主线程卡顿。
- 失败字幕定位截断在旧基线已存在，应归为原有遗漏，而非本次性能优化引入的回归。

验证侧重持续交互下的布局调用次数、隐藏后的停止行为，以及动态面板发现和无关 DOM 变化过滤；未将单元测试结果换算成真实课程页面的 CPU 或功耗降幅。


## 2026-09-21：进一步减少发现与重试开销

调研依据：[MDN MutationObserver.observe](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe)、[WHATWG 对 Shadow 树／attachShadow 观察能力的讨论](https://github.com/whatwg/dom/issues/1287)、[MDN requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)。DOM 观察器可按子树接收变更，但普通文档观察无法覆盖 Shadow 树和已有宿主之后附加 Shadow 根的情况；视频帧回调适合检查字幕时间边界，不应承担无变化时的重复全树发现。

原生 CC 注入改为缓存当前 cue 的文本匹配候选，DOM 文本／树变化、cue 或播放器变化时失效。候选包含当前不可见的匹配节点，因此 CSS 改变可见性时无需重新全树扫描。同步媒体事件先提取尚未递送的 mutation 记录，避免在观察器微任务之前误用旧缓存。保留 750ms 宽限期与宿主滞后字幕匹配语义，但不再在稳定 DOM 的宽限期内每帧重复全树扫描。

定向测试覆盖稳定未匹配状态零重复扫描、CSS 显示隐藏候选、观察器递送前同步插入字幕、宿主滞后／短字幕及隐藏恢复。以上是算法与生命周期验证，不代表真实课程页功耗测量。


播放器发现维护改为增量索引：初始化发现已有 open Shadow 根，之后分别观察 document 与已发现的 Shadow 根，只扫描新增／移除子树，并及时释放断开的观察器和视频监听器。已有宿主后调用 attachShadow 的情况由候选队列分片检查，每批最多 1,000 个元素，一轮目标约 15 秒；后台非画中画与 pagehide 时暂停。此兼容兜底仍可能受浏览器计时器节流、页面规模和 DOM 变化影响，不承诺固定发现时延。

Controller 以视频／字幕轨、相关视频祖先样式、窗口大小、设置及页面状态事件驱动维护，100ms 合并事件，持续事件不延后已排定的维护；无变化时仅保留 15 秒安全检查。耗时异步操作期间不会并发执行，期间发生的新事件只安排一次后续维护。普通进度条／扩展 overlay 的样式变化不会触发维护。destroy 清理索引、观察器、定时器和订阅。

新增测试覆盖：嵌套 Shadow 根同步发现、视频增删、晚挂 Shadow 根、大队列分片、CSS 切换与无关变化过滤、隐藏／画中画、订阅销毁重启、事件合并与低频安全检查。
