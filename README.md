# echo360-online-subtitle-translator

**简体中文** | [English](README.en.md)

用于 Echo360 录播课和 Canvas 内嵌 Instructure Media 视频的 Chrome/Safari 扩展，用来加载并显示翻译字幕。在线服务由扩展直接请求；只有 Argos 与显式选择的“自定义后端”会走后端协议。

当前扩展版本：**1.6.0**

## 功能概览

1. 在当前 Echo360 录播课页面或 Canvas 内嵌视频中寻找 VTT 字幕源（播放器 CC、网络抓取、`transcript-file` API 等）。
2. Google、DeepSeek、Gemini、OpenAI、DeepL、Azure AI Translator 由扩展直接请求（`direct_translator.js`）；Argos 自动使用固定的本机后端；“自定义后端”只在用户明确选择该服务时使用其 URL；“混合翻译”可以同时调度这些路径。
3. Argos 后端调用仓库内的 VTT 翻译脚本作为离线/fallback 工具：`translator/translate_vtt_zh_deepl_native.py`。设置里不再有容易产生矛盾状态的通用“使用本地后端”开关。
4. 扩展将翻译后的 VTT 显示在当前 Echo360 视频上；**默认使用浏览器 `<track>` 字幕轨**。设置中可勾选 **使用原生 CC 注入（Beta）** 尝试注入 Echo360 原生 CC（倍速下仍可能漏译；本课程没有原生字幕位时会自动回退）。
5. **边翻译边显示**（1.3.0）：点击翻译后立即挂载字幕，未完成的 cue 显示 `正在翻译中...`，随批次完成逐步替换为译文。
6. **按 provider 分别保存 API Key**；popup 与 options 页实时同步，切换 provider 时自动带出对应 Key。
7. **AI 手动翻译往返**：点击 `AI 手动翻译` 即下载一个包含全课 cue 的精简 `.translate.json` 并复制简短提示词；支持文件的 AI 可一次翻译后返回完整 `.translated.json`。扩展通过会话绑定校验课程 SHA-256 与目标语言，再检查完整 ID 集合、WebVTT 标签、代码、URL、路径、邮箱和数字，最后以原始 VTT 为不可变骨架在本地重建播放字幕。
8. **Transcript 面板双语增强**是独立的可选表面；新安装和升级默认关闭，用户在字幕设置中明确开启后才会向原生 Transcript cue 添加译文，并保留该选择。



## 字幕源发现

`source_finder.js` 会按优先级尝试多种来源，并把字幕与当前视频匹配：

- 播放器已挂载的 CC / `<track>` VTT
- 页面探针与网络层抓到的 VTT URL
- **Transcript 面板专用路径**（1.2.2）：当播放器没有可用 CC 时，调用  
`/api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/transcript-file?format=vtt`

若所有策略都失败，控制面板会提示「未找到可用字幕源」。

Instructure Media 返回的 SRT 字幕（没有 `WEBVTT` 头、使用逗号毫秒时间码）会在翻译前转换为 WebVTT，保留字幕文字和时间轴。本地后端也支持此输入格式；没有时间轴的 Transcript 纯文本或含空字幕条目的输入仍会被拒绝。
时间轴后的字幕正文即使以 `Note`、`STYLE`、`REGION` 等词开头也正常参与翻译，不会被误当成格式元数据。

## 翻译与显示流程

**自动翻译路径**（直连 Provider、Argos 与支持异步契约的自定义后端）：

1. 点击 `加载翻译字幕` → 若可挂载，立刻显示字幕（未完成 cue 为 `正在翻译中...`）。
2. 翻译进行中 → 每批 partial VTT 热更新已译 cue；状态栏显示 `翻译中 X/Y（已开始显示）`。
3. 全部完成 → 用最终 VTT 做一次增量收尾，无需重新挂载。

翻译期间仍可打开字幕设置和查看诊断信息；启动另一轮翻译等冲突操作会暂时禁用。

设置页的「一键翻译时自动下载字幕并复制提示词」默认关闭。新安装和升级时，如果用户没有设置过该选项，一键按钮只启动字幕翻译，不自动下载 AI 翻译 JSON 材料或写入剪贴板；已明确开启的用户设置会保留。仍可在「AI 手动翻译」中按需导出。

**限制：**

- 扩展内直连任务和本项目 FastAPI 异步任务都支持按批次返回 `partial_vtt`；只实现旧版同步 `/translate` 的自定义后端会等完整 VTT 返回后再显示。
- 命中本地翻译缓存时直接显示完整字幕，不会走增量流程。

### AI 手动翻译

在页面控制面板中展开 `AI 手动翻译`：

1. 点击 `AI 手动翻译` 后，默认下载一份包含全课 cue 的精简 `.translate.json`，同时复制简短提示词。JSON 只把字幕 ID 映射到待翻译文本，不包含时间码、重复上下文、分片清单或客户端校验元数据。
2. 把 JSON 和复制的提示词一次交给能处理文件的 AI。提示词只包含任务规则和条数，不重复嵌入字幕正文；它要求 AI 翻译全部字幕并返回一个完整 `.translated.json`，不需要用户手动拆分、合并或复制多批内容。
3. AI 如果一次无法处理整份文件，点击 `AI 不能一次处理整份文件？改用逐批模式`。此时扩展复制当前小批（最多 80 条 / 4000 个源字符），每次导入后自动保存进度并准备下一批；修复时只会再次发送缺漏或可疑条目。
4. AI 必须直接理解句子并翻译，禁止用词典、正则替换或删除停用词脚本生成译文；无需翻译的字段、ID、数字、代码、URL、路径、邮箱和已有 WebVTT 标签保持不变。说话人/样式外壳由扩展在本地恢复，返回 `.translated.json` 或 JSON 文本后，从剪贴板或文件导入即可。
5. 扩展按会话、请求 ID、完整 cue ID 集合、WebVTT 标签结构、代码/URL/路径/邮箱字面值、数字和部分明显语言缺陷校验结果；合格条目会保留，问题条目会生成下一份补译任务。完整文件若只有孤立、可定位的少量失败（单条失败且至少 10 条、或失败不超过 20 条且成功率至少 99%），会先加载合格译文、把失败 cue 标成待修复并保存本机手动进度；失败过多时仍只保存进度，不把部分内容当成完整译文。原时间码、ID、settings 和元数据保持不变。
6. 最近一节课的手动进度保存在扩展本机 storage，30 天内可恢复；刷新后重新打开手动翻译即可继续。保存失败会提示当前页面仍保有进度。当前 v2 JSON 和完整 VTT 导入路径先按严格规则校验，v2 完整文件遇到少量可定位失败时才进入上面的局部保留流程；质量检查是启发式，不能替代专业译审。此流程不修改直连或后端翻译。

协议字段、校验规则与后续扩展约束见 [手动 AI 字幕翻译协议](docs/manual-ai-translation-protocol.md)。


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
  - 翻译仍使用同一份时间码 VTT 和同一套翻译缓存；字幕按 `video.currentTime` 更新到扩展自己的 overlay，因此不依赖播放器原生 CC 是否打开，也不会在多个视频之间串字幕。默认模式会保留 Vidstack 原生 CC；原生 CC 打开时中文层会自动移到其上方且不重复英文。只有勾选“使用原生 CC 注入（Beta）”时才隐藏原生 surface 并占用它原来的字幕位置。
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
tests/        Vitest 单元/属性测试与 Python 后端/CLI 测试
```

扩展主要模块：

```text
build_config.js           构建目标（dev/store）与 Argos 后端能力标记
assessment_guard.js       Canvas 考试/作业来源检查与默认拒绝安全门
canvas_course_bridge.js   仅限 Canvas 课程内容页/external_tools 的无数据页面证明桥
browser_api.js            Chrome / Safari storage 与 runtime API 抽象
config_keys.js            popup/options 共用的 per-provider API Key 逻辑
constants.js              共享默认值和选项列表
background_contracts.js   service worker 路由、sender 与 target 的纯契约
host_support.js           Echo360 / Canvas Instructure Media 播放器识别与宿主适配
vtt.js                    纯 VTT 解析、格式化、双语与增量预览工具
manual_translation.js     手动 AI 精简 JSON、字面值/标签校验与本地 VTT 重建
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
backend_startup.js        Argos 后端健康检查、去重与分阶段重新拉起
background.js             service worker（直连翻译 job、后端代理与 partial_vtt 存储）
popup.js / options.js     扩展弹窗与选项页
```



## 后端启动

后端与翻译 CLI 支持 Python 3.10 及以上版本。macOS 上建议使用采用 OpenSSL 的 Homebrew/pyenv Python；不要使用 Xcode 自带的旧版 LibreSSL Python，因为当前依赖不再支持该运行时组合。

先进入仓库根目录：

```bash
cd /path/to/echo360-online-subtitle-translator
```

macOS / Linux:

```bash
python -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements.txt
python -m backend.launcher --host 127.0.0.1 --port 8765 --log-level info
```

Windows (PowerShell):

```powershell
py -m venv backend\.venv
backend\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
python -m backend.launcher --host 127.0.0.1 --port 8765 --log-level info
```

`backend.launcher` 默认拒绝非 loopback 监听。只有部署在可信、已认证并终止 TLS 的反向代理后，才可显式使用 `--allow-remote`；CORS 不能替代认证。

健康检查：

```bash
curl http://127.0.0.1:8765/health
```

Windows (PowerShell) 健康检查：

```powershell
Invoke-WebRequest http://127.0.0.1:8765/health
```

### 免 Python 环境的独立后端

发布产物把 Python、FastAPI、翻译脚本、Argos/CTranslate2 运行时、`en→zh`、`en→zt` 和英语 MiniSBD 模型打包在同一个应用目录中。最终用户不需要安装 Python、pip、venv 或 Argos 模型：

- macOS：解压 `echo360-online-subtitle-translator-backend-macos-*.tar.gz`，把 `Echo360 Subtitle Backend.app` 放进“应用程序”并至少打开一次；
- Windows：解压 `echo360-online-subtitle-translator-backend-windows-x64.zip`，首次运行 `Echo360SubtitleBackend\install-and-launch-echo360-subtitle-backend.cmd`，它只在当前用户下注册启动协议，不需要管理员权限。

macOS 包使用系统 AppKit 原生窗口显示运行状态和增量日志；Python/Uvicorn 作为同一 App 包内的后端核心子进程运行，不嵌入 WebView 或 Tk。关闭窗口会同时停止后端核心。

程序固定监听 `127.0.0.1:8765`；选择 Argos 时扩展自动使用该地址，不再要求用户配置 Backend URL。关闭程序即可停止后端。翻译缓存写入当前用户的系统缓存目录，不会写入应用安装目录。

首次启动会把只读应用包中的 Argos 模型复制到当前用户的应用数据目录，因此会比后续启动慢一些。模型安装现在使用跨进程原子锁与完整性复查，避免 server 与 translator 同时启动时互相删除刚安装好的模型。完成上述一次性安装/注册后，扩展在选择 Argos、开始 Argos 翻译、重新翻译或执行 Google 429 备份时都会先检查 `/health`；后端未运行就通过 `echo360-subtitle-backend://start` 请求 Windows/macOS 拉起程序。Edge 的外部协议确认是浏览器安全边界，普通扩展不能静默跳过；需要确认时扩展会把该临时标签页切到前台，后端健康检查成功后自动关闭。启动管理器统一把 `localhost`/`[::1]` 规范为服务实际监听的 `127.0.0.1:8765`，共享并发请求，并在 75 秒窗口内分阶段重发被浏览器/系统吞掉的协议启动。准备阶段会立即报告已知字幕总数，不再长时间显示 `0/0`。失败的尝试会从状态中清除，下一次点击可以真正重试。当前工作流产出的包用于测试和内部发布，尚未配置 Windows Authenticode 或 Apple Developer ID 公证；面向公众分发时应在工作流中接入对应签名凭据。

后端更新后，在目标系统上一条命令即可重建原生包（PyInstaller 不能跨系统构建）：

```bash
python3 -m venv .backend-build-venv
source .backend-build-venv/bin/activate
python -m pip install -r backend/requirements-build.txt
npm run build:backend
python scripts/smoke-backend.py --check-argos
```

Windows PowerShell：

```powershell
py -3.12 -m venv .backend-build-venv
.backend-build-venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements-build.txt
npm run build:backend
python scripts\smoke-backend.py --check-argos
```

默认打包简体和繁体中文模型。可重复传入 `--argos-target` 改变语言集合，例如 `npm run build:backend -- --argos-target zh --argos-target ja`；使用 `--refresh-models` 更新构建缓存中的模型。仓库的 `Build packaged backend` GitHub Actions 工作流会分别原生构建 Windows x64、macOS Apple Silicon 和 macOS Intel，并对 `/health`、冻结后的翻译器分派以及真实 Argos 翻译执行冒烟测试。



## 扩展安装

1. 打开 `chrome://extensions`。
2. 开启开发者模式。
3. 点击 `加载已解压的扩展程序`。
4. 选择当前仓库下的 `extension/` 目录。

进入 Echo360 classroom 页面后，右下角会出现**分体收纳球**：点击大按钮会检查缓存并加载或启动默认翻译；只有在设置中开启「一键翻译时自动下载字幕并复制提示词」后，它才会同时复制 AI 提示词并下载完整 `.translate.json`。旁边的箭头打开滑出式面板，导入图标在字幕会话准备好后可读取 AI 返回的 `.translated.json` 或完整 `.vtt`。首次安装会显示一次性引导气泡。也可通过扩展图标弹窗（`popup.html`）或选项页（`options.html`）配置 provider 与 API Key（各 provider 的 Key 分别保存，切换 provider 时自动切换）。如需清除当前缓存并重新翻译，在面板中点击 `重新翻译`。

## 发布构建

先在仓库根目录安装 Node 依赖：

```bash
npm ci
```

上传 Chrome Web Store 时请使用 store 构建：

```bash
npm run build:store
```

构建产物：

- `dist/extension-store/`
- `dist/echo360-online-subtitle-translator-store.zip`

store 构建保留 Argos 所需的固定 loopback 权限。用户不再切换全局后端开关：选择 Argos 自动连接本机后端，选择在线服务始终直连，选择“自定义后端”才使用用户配置的本机 HTTP 或远程 HTTPS 地址并按 origin 请求可选权限。

本地开发测试可使用：

```bash
npm run build:dev
```

dev 构建同样保留 Argos、本机权限和后端调试参数，并使用开发版名称方便并行安装。

`extension/` 是 Chrome 与 Safari 共用的唯一业务源码。Safari/Xcode 工程引用的是由它生成的 `dist/extension-store/` 发布态资源，而不是另一套需要手工维护的源码；构建过程会生成目标专用的 `build_config.js` 和清单，同时保留独立本地后端能力。

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

`npm run check` 已包含 Python 后端/CLI 回归；只想单独运行这一子集时使用：

```bash
npm run test:python
```

`npm run check` 会检查全部 JavaScript/Python 源文件语法与扩展资源引用，运行 JavaScript 和 Python 测试，并生成 store/dev 两种扩展构建。测试文件位于 `tests/unit/`、`tests/property/` 和 `tests/python/`；配置见 `vitest.config.mjs`。贡献与完整本地门禁见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，安全问题报告方式见 [`SECURITY.md`](SECURITY.md)。

## 默认参数

- provider: `google-web`
- model: 默认空（Gemini 预设为 `gemini-3.1-flash-lite`）
- target: `ZH`
- max_paragraphs: `6`（Google 网页端点会按单条字幕刷新进度）
- max_chars: `1200`
- concurrency: 通用设置默认 `96`；Google Translate 的实际并发上限为 `3`，Azure AI Translator 为 `8`，其他 provider 不变
- rps: 通用配置默认保存为 `0`；Google Translate 会把它解释为安全基线 `6 RPS`，其他 provider 仍按各自适配器处理
- retries: `1`
- timeout: `10`
- reasoning_effort: 默认空
- deepseek_thinking_mode: `disabled`

支持的 provider：`mixed`、`google-web`、`deepseek`、`openai`、`gemini`、`deepl`、`azure`、`argos` 与 `custom-backend`。`google-web`、`argos`、`custom-backend` 不需要 API Key；Azure 需要用户自己的 Translator 订阅密钥。自定义后端必须实现与本项目 `/translate`、`/translate-async`、`/translate-async/{job_id}` 相同的 JSON 契约。

混合翻译采用“分流”而不是“重复请求”：每个字幕 cue 只发给一个 provider，通过平滑加权轮询接近用户设置的目标比例，并按原始 cue 顺序重组结果。各 provider 的工作并行执行且相互隔离；认证/配置错误或 Google 熔断会立即把该 provider 从本次任务的健康池移出，失败或不完整的分片会按健康状态、当前负载和权重依次转交给尚未尝试的 provider。目标比例不是硬性保证，发生故障、配额耗尽或目标语言不兼容时会自动偏离。完整设置页允许勾选任意已有 provider、填写各自 API Key 和权重；未开启多级优先级时至少需要两个与目标语言兼容的 provider。混合配置和 provider 独立 model/endpoint 会进入缓存签名，避免切换组合后误用旧缓存。

可选的**多级优先级**默认关闭。开启后，每级可放一个或多个服务，并通过上移／下移调整整组顺序；默认只用第一级。为后续级别设置递增的字幕条数阈值，整份字幕总数**超过**阈值时，该级加入前几级共同按权重翻译。例如第二级设 500、第三级设 1,500：500 条以内仅第一级，501–1,500 条前两级，1,501 条起三级共同参与。同一 cue 内换行仍算一条。未达到阈值的服务不会被故障转移提前调用；已启用服务失败时优先向较高级别改派。开启时允许只选一个服务；关闭后恢复原有混合逻辑并保留分组设置。调研依据和完整边界规则见 [多级优先级调研](docs/mixed-priority-routing-research.md)。

目标语言选项：`ZH`、`ZH-HK`、`YUE`、`EN`、`JA`、`KO`、`FR`、`DE`、`ES`、`IT`、`PT`、`RU`、`AR`、`HI`。

Chrome 商店版的高级翻译参数只显示与当前 provider 相关的设置：

- OpenAI: `Reasoning Effort`
- DeepSeek: `DeepSeek Thinking`（默认关闭，减少延迟）
- Gemini: 默认模型 `gemini-3.1-flash-lite`
- DeepL: `DeepL Formality`
- Azure AI Translator: 可选的 `Azure Region`

dev 构建会额外保留本地后端调试参数，例如 `maxParagraphs`、`maxChars`、`concurrency`、`rps`、`retries`、`timeout`、`fallbackMode`、`repairConcurrency` 和 `slowSplitThreshold`。

语言补充：

- 当 provider 为 `deepl` 时，不支持 `YUE`（请使用 AI provider，如 `deepseek`/`openai`/`gemini`）
- `argos` 当前明确使用英语作为源语言，支持 `ZH`（`en→zh`）与 `ZH-HK`（`en→zt`）等已安装语言对；不支持 `YUE`，也不接受 `EN` 作为目标语言

Azure AI Translator provider：

- `azure` 使用官方 Translator v3 REST API；请在 Azure 创建 F0 Translator 资源，并在扩展中填写该资源的订阅密钥
- 全局 Translator 资源只需密钥；多服务或区域型资源还需在高级设置填写 Azure 门户显示的 Region/Location（例如 `australiaeast`）
- 留空 Endpoint 时使用 `https://api.cognitive.microsofttranslator.com/translate`；如使用 Azure 自定义域名，请填写完整的 translate endpoint
- 一次请求直接提交一个字幕批次，保持输入和输出索引对应；当前每批仍受 `max_paragraphs=6`、`max_chars=1200` 约束，并将并发上限固定为 `8`
- `ZH`、`ZH-HK`、`YUE` 分别映射到 Azure 的 `zh-Hans`、`zh-Hant`、`yue`；其他项目目标语言也直接映射到对应 Azure 代码
- HTTP 429、超时和 5xx 使用现有重试/退避路径；无效凭据、无效输出和不完整批次不会写入成功缓存
- API Key 只由 service worker 从扩展本地存储读取并注入，请勿把共享密钥写入仓库或发布包
- 官方参考：[身份验证](https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/authentication)、[Translate API](https://learn.microsoft.com/rest/api/translator/translator/translate?view=rest-translator-v3.0)、[语言支持](https://learn.microsoft.com/azure/ai-services/translator/language-support)

Google Translate provider：

- `google-web` 使用非官方网页端接口，不需要 API key，适合首次安装后快速试用；Google 官方社区明确说明该端点不受维护，不建议用于生产
- 所有构建都由扩展前端直接请求，不受 Argos 或自定义后端配置影响
- 后端/脚本路径和扩展直连路径都把 Google 限制为共享 `6 RPS / 3 并发`，仍保持 `max_chars=1200, max_paragraphs=1`
- 该接口非官方，稳定性、可用性和翻译质量不保证
- 如果重视字幕翻译质量和接口稳定性，建议改用官方 API provider（如 `azure`/`deepl`）或 AI provider，并填写自己的 API Key

`google-web` 的直接扩展和 Python 路径默认使用共享 `6 RPS / 3 并发`；即使旧配置为 `rps=0`，也会应用这一安全基线，较低的显式 RPS 值仍会保留。每条字幕独立处理；零星 `HTTP 429` 会遵循 `Retry-After` 或带抖动的指数退避，但若 10 秒内累计 5 个 429 就立即熔断：停止新的 Google 请求和重试，并自动拉起本地后端改用 Argos；在混合模式中则把失败分片转交给其余健康 provider。Python 本地后端路径使用同一阈值，并保留已经成功的 Google 译文，只让 Argos 补齐未完成字幕。最终仍失败的字幕保留原文、列入 `failed_items`，部分结果不会写入缓存。扩展 Console 会打印有效并发/RPS、批次进度、熔断和备份摘要。该端点没有公开、稳定的官方 QPS 承诺，因此不要把正式 Google Cloud Translation 的配额直接套用到它。调研依据：[Google 开发者社区关于该非官方端点的说明](https://discuss.google.dev/t/translate-googleapis-com-translate-a/126639)、[Google Cloud Translation 官方配额（仅作正式 API 对照）](https://docs.cloud.google.com/translate/quotas)。

混合路由的设计参考了成熟网关的加权分流、重试/故障转移和异常实例摘除模式，而不是把同一字幕重复发送给所有服务：[Envoy Gateway 负载均衡](https://gateway.envoyproxy.io/docs/concepts/load-balancing/)、[Envoy 异常检测](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier)、[Azure Circuit Breaker pattern](https://learn.microsoft.com/azure/architecture/patterns/circuit-breaker)、[Azure Bulkhead pattern](https://learn.microsoft.com/azure/architecture/patterns/bulkhead)。

Argos Translate provider：

`argos` 直接在现有 Python 翻译子进程中加载本机 Argos 模型，不需要再启动 LibreTranslate 服务，也不会把字幕发送到第三方。为了避免 CTranslate2 模型竞争和重复占用内存，运行时固定为单 worker。独立后端发布包已经包含简体/繁体中文模型；只有源码开发模式需要在后端虚拟环境安装可选依赖和所需模型：

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

最后一条命令会显式预下载英语 MiniSBD 断句模型。然后在完整设置中选择 `Argos Translate（本地）`；保存或开始翻译时会自动检查并拉起 `127.0.0.1:8765`，无需另设开关。翻译过程中不会静默联网或下载模型：缺少依赖、语言包或断句模型时，界面会分别显示 `ARGOS_DEPENDENCY_MISSING` 或 `ARGOS_MODEL_MISSING` 及安装提示。

为降低本地翻译时的 CPU 争抢，默认将 CTranslate2 翻译线程和 MiniSBD/ONNX 断句线程分别限制为 2，并保持单批次翻译。断句器的线程池独立于翻译引擎，因此两者都会显式限制；模型仍由 Argos 自身缓存复用。源码启动时可设置 `ARGOS_INTRA_THREADS=1` 进一步降低占用，或设置其他正整数调整线程数；显式设为 `0` 恢复自动线程选择。修改环境变量后需重启后端。此设置优先保证电脑响应，长字幕的完成时间可能增加。

本地翻译替代方案的质量、速度、体积、许可证和迁移建议见 [本地机器翻译调研](docs/local-translation-research.md)。



## 隐私

详见 [PRIVACY.md](PRIVACY.md)。扩展会将字幕文本发送到用户明确选择的翻译服务；选择 `argos` 时字幕只在本机处理，选择“自定义后端”时发送到用户配置的地址。手动 AI 模式只在本地生成/读取文件，文件交给哪个 AI 由用户决定。API Key 与字幕缓存保存在 Chrome 本地 storage。

## 后端翻译脚本调用方式

后端直接构造参数列表，不通过 shell 拼接命令。默认调用方式：

```text
TRANSLATOR_API_KEY=... python translator/translate_vtt_zh_deepl_native.py input.vtt --out translated.vtt --provider deepseek --model deepseek-v4-flash --target ZH
```

可选环境变量覆盖：

```bash
export TRANSLATOR_SCRIPT=/absolute/path/to/translate_vtt_zh_deepl_native.py
export TRANSLATOR_PYTHON_BIN=/absolute/path/to/python
export TRANSLATOR_TASK_TIMEOUT_SECONDS=480
```

整任务 deadline 默认 480 秒，并被限制在 30–480 秒范围内；超时后后端会先终止、再强制回收翻译进程树。前端会为终止清理和类型化错误回传额外保留一分钟轮询窗口，因此不允许把后端期限调到客户端窗口之外。

翻译脚本来自上游仓库 [bryanxianyu/VTT-Translator](https://github.com/bryanxianyu/VTT-Translator)，当前仓库内为 vendor 快照（`translator/translate_vtt_zh_deepl_native.py`）。

后端会检测翻译脚本是否支持以下可选参数：

- `--request-timeout`
- `--openai-reasoning-effort`

如果当前翻译脚本不支持某个可选参数，后端会跳过并输出 warning，而不是强行传入导致失败。

## 缓存策略

源码模式会将翻译后的 VTT 存到已被 git 忽略的 `backend/.cache/`；独立后端使用当前用户的系统缓存目录。可用 `ECHO360_CACHE_DIR` 显式覆盖。

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
- 增量预览的 partial VTT 由 `direct_translator.js` 或 FastAPI 异步任务按批次产出，经 job 轮询交给 `buildIncrementalPreviewVtt()` 把未译 cue 替换为占位文案；混合翻译会按原始 cue 位置安全合并各子 provider 的 partial，不再等待整个 provider 分片；旧版同步自定义后端没有这一能力。
