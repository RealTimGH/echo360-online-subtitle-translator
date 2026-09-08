# echo360-online-subtitle-translator

**简体中文** | [English](README.en.md)

用于 Echo360 录播课和 Canvas 内嵌 Instructure Media 视频的 Chrome/Safari 扩展，用来加载并显示翻译字幕；本地 FastAPI 后端保留为开发调试、fallback 和批处理路径。

当前扩展版本：**1.5.0**

## 功能概览

1. 在当前 Echo360 录播课页面或 Canvas 内嵌视频中寻找 VTT 字幕源（播放器 CC、网络抓取、`transcript-file` API 等）。
2. 默认通过扩展前端直连翻译服务（`direct_translator.js`）；dev 构建也可以发送到本地后端。
3. 如果启用本地后端，后端会调用仓库内的 VTT 翻译脚本作为 fallback/批处理工具：
  `translator/translate_vtt_zh_deepl_native.py`
4. 扩展将翻译后的 VTT 显示在当前 Echo360 视频上；**默认使用浏览器 `<track>` 字幕轨**。设置中可勾选 **使用原生 CC 注入（Beta）** 尝试注入 Echo360 原生 CC（倍速下仍可能漏译；本课程没有原生字幕位时会自动回退）。
5. **边翻译边显示**（1.3.0）：点击翻译后立即挂载字幕，未完成的 cue 显示 `正在翻译中...`，随批次完成逐步替换为译文。
6. **按 provider 分别保存 API Key**；popup 与 options 页实时同步，切换 provider 时自动带出对应 Key。



## 字幕源发现

`source_finder.js` 会按优先级尝试多种来源，并把字幕与当前视频匹配：

- 播放器已挂载的 CC / `<track>` VTT
- 页面探针与网络层抓到的 VTT URL
- **Transcript 面板专用路径**（1.2.2）：当播放器没有可用 CC 时，调用  
`/api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/transcript-file?format=vtt`

若所有策略都失败，控制面板会提示「未找到可用字幕源」。

## 翻译与显示流程

**直连翻译路径**（store 构建默认、dev 未开本地后端时）：

1. 点击 `加载翻译字幕` → 若可挂载，立刻显示字幕（未完成 cue 为 `正在翻译中...`）。
2. 翻译进行中 → 每批 partial VTT 热更新已译 cue；状态栏显示 `翻译中 X/Y（已开始显示）`。
3. 全部完成 → 用最终 VTT 做一次增量收尾，无需重新挂载。

**限制：**

- 增量预览目前仅支持扩展内直连翻译（`direct_translator.js` → background job）；本地 FastAPI 后端路径仍等整份 VTT 返回后再显示。
- 命中本地翻译缓存时直接显示完整字幕，不会走增量流程。



## 字幕渲染方式

**默认策略是浏览器 `<track>` 字幕轨**（可靠路径）。Echo360 原生 CC 注入已降为设置中的 **Beta 可选**（`renderer.js` + `bilingual_dom_renderer.js`）：

1. **默认（浏览器字幕轨）**
  - 单语模式直接挂载翻译 VTT。
  - 双语模式由 `subtitle_strategy.js` 按浏览器选择策略：Safari 使用单 cue 双语 VTT，Chrome / Edge 等使用分 cue 双语 VTT。
  - 双语、顺序、大小等选项可编辑。
2. **可选 Beta：Echo360 原生 CC 注入**
  - 在设置 popover 勾选 **使用原生 CC 注入（Beta）**（`ui_popover.js`）后，尝试把译文注入 Echo360 播放器自带 CC 区域（英文在上、中文在下），外观与原生字幕一致。
  - **已知限制**：倍速播放时 Echo360 自身 caption DOM 常落后于播放进度，仍可能出现漏译；该路径短期内无法保证与浏览器轨同等可靠，因此不再作为默认。
  - 1.2.1 起改进了 DOM 匹配与注入时序；1.3.0 起支持通过 `updateTranslatedVtt()` **边翻译边显示**。
  - 原生 CC 模式下双语/顺序被强制为双语、非 reverse；大小等选项不可编辑。
  - `hasNativeCaptionCapability()`（`source_finder.js`）区分"这节课本来就没有原生字幕位"和"用户/Echo360 只是当前没打开 CC"。主要信号是播放器控制栏 **"Toggle Captions" 按钮是否存在**；`<track>`/`TextTrack` 存在时也算有能力：
    - 没有该按钮且没有 `<track>`/`TextTrack` → 挂载时立刻回退浏览器轨。
    - 按钮存在但关闭（`aria-pressed="false"`）→ 视为用户主动选择，保持沉默。
    - 兜底：匹配宽限期结束后若确认无能力，仍会自动切到浏览器轨（不写入已保存偏好）。

偏好 schema v3 起会把旧版「原生 CC 默认」一次性迁移为浏览器轨默认；需要原生外观的用户可在设置中重新勾选 Beta。

3. **Canvas / Instructure Media 视频**
  - Canvas 页面里的视频实际运行在 `sydney.instructuremedia.com` 的独立 iframe 中，播放器使用 Vidstack 的自定义 `[data-part="captions"]` 渲染层；扩展会在每个 iframe 内独立识别视频，避免把页面上的多个视频混成一个。
  - 翻译仍使用同一份时间码 VTT 和同一套翻译缓存；字幕按 `video.currentTime` 直接更新到播放器 captions surface，因此不依赖播放器原生 CC 是否打开，也不会在多个视频之间串字幕。
  - 如果字幕 URL 的跨域响应不允许 content script 直接读取，扩展会把请求交给 service worker，但只允许 `*.instructuremedia.com`，不会变成任意网址代理。

### Canvas 考试安全模式

- 扩展只在 Canvas 顶层的 `/courses/*/pages/*` 课程内容页和 `/courses/*/external_tools/*` 独立外部工具页注入 `canvas_course_bridge.js`；不会在 `quizzes`、`assignments`、`taking`、`modules/items` 或其他 Canvas 路径注入。课程页桥只验证当前 URL、检查高可信考试 DOM 标记并回复媒体 iframe 的一次性 nonce，不修改 DOM，不读取页面正文、键盘输入或扩展存储，也不发起网络请求。
- Canvas 内嵌的 Echo360 / Instructure Media iframe 由 `assessment_guard.js` 在其他模块启动前检查。referrer 含完整 `/courses/{id}/pages/{slug}` 或 `/courses/{id}/external_tools/{tool_id}` 路径时可直接启用；若浏览器的 referrer policy 只暴露 Canvas origin，iframe 必须从上述课程页桥取得同 request ID 的页面证明才能启动。
- `quizzes`、`assignments`、New Quizzes/taking 等考试路径没有课程页桥，因此一律默认禁用。未取得证明、无 referrer、来源模糊或发现考试 DOM 标记时也默认禁用。
- 禁用时除最长 1.5 秒的一次性 `postMessage` 验证监听外，不会创建翻译 UI、字幕轨、页面探针、持续定时器或媒体事件监听，也不会读取扩展存储或发起翻译请求。

该保护用于减少插件对考试页面的影响，但任何插件都无法保证不会被学校的监考软件仅因“已安装”而报告。若考试规则禁止浏览器扩展，最稳妥的做法仍是在考试前从浏览器扩展管理页停用本扩展，并按学校要求使用指定浏览器或独立考试配置文件。

切换显示偏好（双语、顺序、大小）不需要重新翻译；扩展端只缓存一份翻译 VTT，在前端渲染。

## 目录结构

```text
backend/      FastAPI 开发/fallback 服务和本地翻译缓存
extension/    Chrome/Safari 扩展源码
translator/   VTT 翻译脚本（后端/fallback 调用）
scripts/      扩展构建脚本
tests/        Vitest 单元测试（覆盖 extension 核心逻辑）
```

扩展主要模块：

```text
build_config.js           构建目标（dev/store）与本地后端开关
assessment_guard.js       Canvas 考试/作业来源检查与默认拒绝安全门
canvas_course_bridge.js   仅限 Canvas 课程内容页/external_tools 的无数据页面证明桥
browser_api.js            Chrome / Safari storage 与 runtime API 抽象
config_keys.js            popup/options 共用的 per-provider API Key 逻辑
constants.js              共享默认值和选项列表
host_support.js           Echo360 / Canvas Instructure Media 播放器识别与宿主适配
vtt.js                    纯 VTT 解析、格式化、双语与增量预览工具
subtitle_strategy.js      浏览器检测与双语 VTT 构建策略
storage.js                配置、偏好和本地字幕缓存
video.js                  Echo360 视频发现、media-id 线索和页面探针桥接
source_finder.js          字幕源发现（含 transcript-file API）和字幕到视频匹配
player_caption_renderer.js Canvas Vidstack captions overlay 的定时字幕渲染
bilingual_dom_renderer.js Echo360 原生 CC DOM 双语注入
renderer.js               浏览器字幕 track / 原生 CC DOM 渲染编排与 cue 样式
direct_translator.js      扩展内直连翻译与 partial VTT 回调（store 默认路径）
ui.js                     页面 UI 门面（组装 ball / panel / popover / onboarding）
ui_ball.js                右下角收纳球入口
ui_panel.js               滑出式翻译面板
ui_popover.js             显示与渲染偏好 popover
ui_onboarding.js          首次安装引导气泡
ui_styles.js / ui_theme.js 页面 UI 样式与浅色/深色主题
backend_client.js         后端代理、直连任务轮询（含 partial_vtt）和错误消息
translation_service.js    payload 构造、缓存键与翻译编排
controller.js             翻译用例编排（含增量预览挂载）
content.js                content script 入口
page_probe.js             MAIN world 的 Echo360/React/XHR 探针
background.js             service worker（直连翻译 job 与 partial_vtt 存储）
popup.js / options.js     扩展弹窗与选项页
```



## 后端启动

后端与翻译 CLI 支持 Python 3.9 及以上版本。macOS 上建议使用采用 OpenSSL 的 Homebrew/pyenv Python；Xcode 自带的 LibreSSL Python 可启动程序，但当前 `urllib3` 不对该 TLS 栈提供完整支持。

先进入仓库根目录：

```bash
cd /path/to/echo360-online-subtitle-translator
```

macOS / Linux:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765 --reload
```

Windows (PowerShell):

```powershell
cd backend
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765 --reload
```

健康检查：

```bash
curl http://127.0.0.1:8765/health
```

Windows (PowerShell) 健康检查：

```powershell
Invoke-WebRequest http://127.0.0.1:8765/health
```



## 扩展安装

1. 打开 `chrome://extensions`。
2. 开启开发者模式。
3. 点击 `加载已解压的扩展程序`。
4. 选择当前仓库下的 `extension/` 目录。

进入 Echo360 classroom 页面后，右下角会出现**收纳球**；点击展开滑出式翻译面板，齿轮按钮打开显示/渲染偏好 popover。首次安装会显示一次性引导气泡。也可通过扩展图标弹窗（`popup.html`）或选项页（`options.html`）配置 provider 与 API Key（各 provider 的 Key 分别保存，切换 provider 时自动切换）。正常使用点击 `加载翻译字幕`；如果需要清除当前缓存并重新翻译，点击 `重新翻译`。

## 发布构建

先在仓库根目录安装 Node 依赖：

```bash
npm install
```

源码默认保留本地后端开关，方便开发测试。上传 Chrome Web Store 时请使用 store 构建：

```bash
npm run build:store
```

构建产物：

- `dist/extension-store/`
- `dist/echo360-online-subtitle-translator-store.zip`

store 构建会禁用并隐藏本地后端入口，同时从 `manifest.json` 移除 `localhost` / `127.0.0.1` 权限。

本地开发测试可使用：

```bash
npm run build:dev
```

dev 构建保留本地后端入口和 localhost 权限。

`extension/` 是 Chrome 与 Safari 共用的唯一业务源码。Safari/Xcode 工程引用的是由它生成的 `dist/extension-store/` 发布态资源，而不是另一套需要手工维护的源码；这层构建产物会有意改写 `build_config.js`、`manifest.json` 和 `options.html`，以移除本地后端入口与权限。

打开 Xcode 或 Build/Run 前先执行：

```bash
npm run safari:prepare
```

该命令会从当前 `extension/` 重新生成 store 资源，并严格验证三件事：构建产物的每个文件内容与源码及发布态转换完全一致、Xcode 的两个 Extension target 都包含完整资源、所有 Xcode 引用都精确指向 `dist/extension-store/`。校验失败时不要继续用 Xcode 里的旧产物。

修改扩展脚本后，还需要在 Xcode 中重新 Build/Run containing app，并关闭后重新打开 Safari 的 Canvas/EchoVideo 页面；生成资源本身不会更新已经安装的 Safari App bundle。普通质量门禁中的 `npm run check:safari` 也会执行相同的防漂移校验；若当前环境没有生成 Safari 工程则跳过工程校验。

## 测试

单元测试和属性测试覆盖 `extension/` 中的 VTT 解析、字幕策略、存储、翻译 payload、跨浏览器 API 适配与错误处理逻辑。提交前建议运行完整质量门禁：

```bash
npm ci
npm run check
npm run test:coverage
```

安装 `backend/requirements.txt` 后，可另行运行 Python 后端/CLI 冒烟回归：

```bash
npm run test:python
```

`npm run check` 会检查全部 JavaScript/Python 源文件语法，运行扩展测试，并生成 store/dev 两种扩展构建。测试文件位于 `tests/unit/`、`tests/property/` 和 `tests/python/`；配置见 `vitest.config.js`。

## 默认参数

- provider: `google-web`
- model: 默认空（Gemini 预设为 `gemini-3.1-flash-lite`）
- target: `ZH`
- max_paragraphs: `6`（Google 网页端点会按单条字幕刷新进度）
- max_chars: `1200`
- concurrency: `96`（首次请求沿用 1.4.2；失败时才自动尝试低并发恢复）
- rps: `0`（首次请求不额外限速；失败时才自动尝试 `3` RPS 恢复）
- retries: `1`
- timeout: `10`
- reasoning_effort: 默认空
- deepseek_thinking_mode: `disabled`

支持的 provider：`google-web`、`deepseek`、`openai`、`gemini`、`deepl`，以及仅开发版/本地后端可用的 `argos`。`google-web` 与 `argos` 不需要 API Key。

目标语言选项：`ZH`、`ZH-HK`、`YUE`、`EN`、`JA`、`KO`、`FR`、`DE`、`ES`、`IT`、`PT`、`RU`、`AR`、`HI`。

Chrome 商店版的高级翻译参数只显示与当前 provider 相关的设置：

- OpenAI: `Reasoning Effort`
- DeepSeek: `DeepSeek Thinking`（默认关闭，减少延迟）
- Gemini: 默认模型 `gemini-3.1-flash-lite`
- DeepL: `DeepL Formality`

dev 构建会额外保留本地后端调试参数，例如 `maxParagraphs`、`maxChars`、`concurrency`、`rps`、`retries`、`timeout`、`fallbackMode`、`repairConcurrency` 和 `slowSplitThreshold`。

语言补充：

- 当 provider 为 `deepl` 时，不支持 `YUE`（请使用 AI provider，如 `deepseek`/`openai`/`gemini`）
- `argos` 当前明确使用英语作为源语言，支持 `ZH`（`en→zh`）与 `ZH-HK`（`en→zt`）等已安装语言对；不支持 `YUE`，也不接受 `EN` 作为目标语言

Google Translate provider：

- `google-web` 使用非官方网页端接口，不需要 API key，适合首次安装后快速试用
- store 构建会由扩展前端直接请求；dev 构建可选择通过本地后端转发
- 后端/脚本路径恢复 1.4.2 的速度配置：默认 `concurrency=96, rps=0`（不增加请求间隔），同时保持 `max_chars=1200, max_paragraphs=1` 以便逐条显示增量进度
- 该接口非官方，稳定性、可用性和翻译质量不保证
- 如果重视字幕翻译质量，建议改用 AI/API provider（如 `deepseek`/`openai`/`gemini`/`deepl`）并填写自己的 API Key

`google-web` 的直接扩展路径恢复 1.4.2 的默认速度：最多 `96` 个 worker，默认 `rps=0`（不增加请求间隔）；显式设置正数 `rps` 时仍会按该值排队。每条字幕独立处理，遇到 `HTTP 429` 会按 `Retry-After` 或指数退避重试；最终失败的字幕保留原文、列入 `failed_items`，并且部分结果不会写入缓存。扩展 Console 会打印有效并发/RPS、批次进度、重试、429、队列等待和最终失败摘要。该端点没有公开、稳定的官方 QPS 承诺，因此不要把正式 Google Cloud Translation 的配额直接套用到它。

Argos Translate provider（仅开发版）：

`argos` 直接在现有 Python 翻译子进程中加载本机 Argos 模型，不需要再启动 LibreTranslate 服务，也不会把字幕发送到第三方。为了避免 CTranslate2 模型竞争和重复占用内存，运行时固定为单 worker。先在后端虚拟环境安装可选依赖和所需模型：

```bash
cd backend
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-argos.txt
argospm update
argospm install translate-en_zh
python -c 'from argostranslate import sbd; sbd.minisbd_models.download_models(["en"])'
# 如需繁体中文：argospm install translate-en_zt
```

最后一条命令会显式预下载英语 MiniSBD 断句模型。然后构建并加载开发版扩展，在完整设置中选择 `Argos Translate（本地）`。保存时会自动启用本地后端；后端仍按原方式在 `127.0.0.1:8765` 启动。翻译过程中不会静默联网或下载模型：缺少依赖、语言包或断句模型时，界面会分别显示 `ARGOS_DEPENDENCY_MISSING` 或 `ARGOS_MODEL_MISSING` 及安装提示。



## 隐私

详见 [PRIVACY.md](PRIVACY.md)。扩展会将字幕文本发送到用户选择的翻译服务；选择 `argos` 时字幕只在本机处理。API Key 与字幕缓存保存在 Chrome 本地 storage。

## 后端翻译脚本调用方式

后端直接构造参数列表，不通过 shell 拼接命令。默认调用方式：

```text
python translator/translate_vtt_zh_deepl_native.py input.vtt --out translated.vtt --key ... --provider deepseek --model deepseek-v4-flash --target ZH
```

可选环境变量覆盖：

```bash
export TRANSLATOR_SCRIPT=/absolute/path/to/translate_vtt_zh_deepl_native.py
export TRANSLATOR_PYTHON_BIN=/absolute/path/to/python
```

翻译脚本来自上游仓库 [bryanxianyu/VTT-Translator](https://github.com/bryanxianyu/VTT-Translator)，当前仓库内为 vendor 快照（`translator/translate_vtt_zh_deepl_native.py`）。

后端会检测翻译脚本是否支持以下可选参数：

- `--request-timeout`
- `--openai-reasoning-effort`

如果当前翻译脚本不支持某个可选参数，后端会跳过并输出 warning，而不是强行传入导致失败。

## 缓存策略

后端会将翻译后的 VTT 存到 `backend/.cache/`，该目录已被 git 忽略。

后端缓存身份基于会影响内容的输入：

- 原始 VTT 文本
- provider/model/endpoint
- 目标语言
- max paragraphs/chars
- 后端双语模式
- reasoning effort

并发数、RPS、重试次数、timeout 这类只影响性能的参数不参与内容缓存键。

扩展端只保留一个本地翻译字幕缓存。双语显示在前端渲染，因此切换双语显示不需要重新翻译。

## 说明

- `page_probe.js` 会注入页面上下文，用于读取 Echo360/React 视频 UUID 线索，从而提高字幕和视频匹配的准确性。
- 探针默认不抓取详细网络请求 body。
- 如果录播存在独立开场片段，扩展会优先使用强 media-id 映射，其次使用 timeline/state 兜底匹配。
- 仅 Transcript 面板、无播放器 CC 的课时依赖 `transcript-file` API（1.2.2）；这类页面没有 Echo360 原生 CC DOM 可注入，会被 `hasNativeCaptionCapability()` 判定为无能力并直接使用浏览器字幕轨。
- 增量预览的 partial VTT 由 `direct_translator.js` 每批产出并经 `background.js` job 轮询；`buildIncrementalPreviewVtt()` 负责把未译 cue 替换为占位文案。
