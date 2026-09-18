# Echo360 Online Subtitle Translator 软件工程完整审查报告

审查日期：2026-09-12 至 2026-09-13  
审查范围：当前未提交工作树，包括 Chrome/Safari 扩展、FastAPI 本地后端、Python 翻译器、测试、构建脚本、依赖与 GitHub Actions。  
审查方式：源码与依赖静态审查、架构/质量/安全三路并行复核、基线测试、联网核对行业规范、整改、全量回归与最终差异复核。

> 注意：审查开始时工作树已经包含一批用户未提交的混合翻译、限流和 UI 改动。本次把这些内容视为“当前项目状态”，未回退、覆盖或清理；报告评价与验证对象是合并后的当前工作树。

## 1. 执行结论

项目的产品边界总体清楚：`extension/` 负责浏览器能力和 UI，`backend/` 负责本地 HTTP/任务调度，`translator/` 是可单独运行的翻译器快照，`scripts/` 与 `tests/` 也有明确用途。字幕结果校验、错误脱敏、assessment fail-closed、安全的 DOM 文本写入、构建目标区分和较丰富的单元/属性测试均是现有优势。

但审查前不能评价为“已经完整符合最佳实践”，主要原因是：核心模块职责过多；MV3 与后端异步任务都依赖易失内存；普通 PR 没有 CI；覆盖率隐藏未加载文件；消息代理权限边界过宽；后端请求与任务缺少硬上限；Python 运行时依赖存在公开漏洞；发布供应链还未完成签名、公证与可复现锁定。

本次已完成风险可控且能自动验证的整改。整改后，项目从“功能测试较强、工程门禁不足”提升为“具备可执行质量门禁和明显更窄安全边界”，但仍有两项需要独立设计任务的高优先级技术债：**可恢复的持久化任务系统**和**核心 god module 的分阶段拆分**。

| 质量维度 | 整改前 | 整改后 | 结论 |
|---|---:|---:|---|
| 结构清晰度 | 6.5/10 | 7.0/10 | 顶层边界清楚，核心文件内部边界仍偏弱 |
| 可维护性/复用 | 5.5/10 | 6.5/10 | 增加公共后台契约与规范化，但跨 JS/Python 协议仍有重复 |
| 正确性 | 7.5/10 | 8.5/10 | 修复 endpoint/目标别名/混合回退/全局 deadline 漂移，604+48 测试通过 |
| 测试与 CI | 6.0/10 | 8.0/10 | 增加 PR/push CI、结构检查、真实覆盖率及阈值 |
| 安全与可靠性 | 5.5/10 | 8.0/10 | 消息/代理/监听/资源上限、流式读取和子进程 deadline 已加固；任务恢复尚缺 |
| 供应链 | 4.5/10 | 7.0/10 | npm 漏洞清零、Actions 固定 SHA、Dependabot；打包栈仍有 PyTorch 残余风险 |

评分是基于当前仓库的工程判断，不是认证结果，也不等价于通过 ISO、NIST 或 OWASP 的正式合规审核。

## 2. 采用的行业依据

- [ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html)：以功能适合性、性能效率、兼容性、交互能力、可靠性、安全性、可维护性、灵活性和安全保障等质量特征评估产品质量。
- [ISO/IEC/IEEE 12207:2026](https://www.iso.org/standard/90219.html)：把软件生命周期活动、过程控制和持续改进作为统一框架。本次因此不只看代码，也检查测试、构建、依赖、发布和维护流程。
- [NIST Secure Software Development Framework, SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final)：要求把安全实践嵌入 SDLC，以减少漏洞数量、降低残余影响并处理根因。
- [OWASP ASVS 4.0](https://wiki.owasp.org/images/d/d4/OWASP_Application_Security_Verification_Standard_4.0-en.pdf) 与 [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)：用于审查输入边界、认证假设、敏感信息、错误与日志。
- [Chrome Extension Manifest V3 安全指南](https://developer.chrome.com/docs/extensions/mv3/security)：要求最小权限、HTTPS、严格 CSP、验证 content-script 消息并限制特权操作；[Chrome Web Store 最佳实践](https://developer.chrome.com/docs/webstore/best-practices) 还建议端到端和跨浏览器/系统/网络状态测试。
- [GitHub Actions 安全使用](https://docs.github.com/en/actions/reference/security/secure-use)：第三方 Action 应固定到完整 commit SHA，并赋予最小 `GITHUB_TOKEN` 权限；[GitHub CI 指南](https://docs.github.com/en/actions/get-started/continuous-integration) 用于建立普通 push/PR 反馈门禁。
- [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/) 与 [npm audit](https://docs.npmjs.com/cli/audit/)：CI 使用锁文件进行干净、不可修改的安装，并持续检查公开依赖漏洞。
- [FastAPI 版本管理指南](https://github.com/tiangolo/fastapi/blob/master/docs/en/docs/deployment/versions.md) 建议固定已测试的 FastAPI 版本而不要单独覆盖 Starlette；[FastAPI release notes](https://github.com/tiangolo/fastapi/blob/master/docs/en/docs/release-notes.md) 显示 0.129 起停止 Python 3.9 支持。本次因此同步抬高最低 Python，而不是把新版 Starlette 强塞给旧 FastAPI。
- [Vitest 4 migration guide](https://vitest.dev/guide/migration.html) 说明 Vitest 4 的 Node 要求；结合锁文件中 Vite 的实际 engines，项目现在声明精确的 `^20.19.0 || ^22.12.0 || >=24.0.0` 合同。

## 3. 当前架构与依赖关系

```text
Canvas / Echo360 页面
  ├─ MAIN world: assessment_guard_main.js + page_probe.js
  └─ ISOLATED world: content scripts（按 manifest 手工顺序加载）
       ├─ source_finder / VTT / transcript adapters
       ├─ translation_service / direct_translator
       ├─ renderer / transcript panel / UI
       └─ backend_client ──runtime message──> MV3 background service worker
                                              ├─ 直连 provider API
                                              └─ 固定协议代理 ──> FastAPI backend
                                                                  └─ translator Python subprocess
```

顶层目录逻辑合理，但以下核心文件同时承担 API、领域逻辑、基础设施或 UI 编排：

- `backend/app.py`：约 2,100 行，混合路由、Pydantic 模型、VTT 校验、缓存、子进程、错误协议和任务 registry。
- `extension/background.js`：约 1,500 行，混合安全边界、缓存、任务、provider 调度和后端代理。
- `extension/direct_translator.js`：约 1,900 行，混合 provider adapter、endpoint/auth、限流/重试/熔断、批处理和结果编排。
- `extension/controller.js`、`error_utils.js`、`manual_translation.js`：各约 1,700–1,800 行。

这不是单纯的“文件太长”问题，而是修改理由不同的职责被放在一起，降低独立测试、review 和替换能力。

## 4. 发现、风险与整改状态

### P1-1：异步任务不可恢复——未在本次仓促重写

证据：浏览器直连任务只保存在 `background.js` 的 `Map`，并由 detached async IIFE 执行；MV3 service worker 重启后，任务、进度和部分结果全部消失。FastAPI 同样以进程内 `_jobs` 和 daemon thread 执行；进程重启、多 worker 或崩溃后无法恢复。

影响：最长 8 分钟的前端轮询不能保证任务生命周期；重启后只会得到 `JOB_NOT_FOUND`。这属于架构 P1，而不是增加一次 retry 就能正确解决的问题。

状态：**未完成，列入第一优先级后续任务**。本次先增加浏览器和后端各 4 个 active job 的 admission 上限，阻止无界线程/任务增长，但这不等价于持久化或恢复。

正确方案：建立版本化 job store，至少持久化请求签名、状态、进度、partial VTT、结果、错误、创建者与过期时间；让 service worker 只负责可恢复入队；后端采用固定 worker pool/任务进程，并增加取消、deadline、重启恢复和多进程一致性测试。

### P1-2：普通改动没有 CI——已修复

审查前唯一 workflow 只在 tag 或手工触发时打包后端，589 个 JavaScript 测试、扩展构建、manifest/Safari 资源均不是合并门禁。

整改：

- 新增 `.github/workflows/ci.yml`，在 PR 以及 `main`/`develop` push 执行 `npm ci`、Python 依赖安装、完整 `npm run check`、npm/Python 依赖审计和覆盖率；Python 3.10、3.13 组成支持边界矩阵。
- workflow 采用 `permissions: contents: read`。
- 新旧 workflows 的 GitHub Actions 全部固定到完整 commit SHA，并更新到当前使用 Node 24 runtime 的 checkout/setup/cache 主版本；避免依赖已进入淘汰周期的 Action 内置 Node 运行时。
- release 构建的 Argos asset cache key 加入 requirements/build script hash，避免输入变化后复用旧模型缓存。

状态：**已完成，需由下一次真实 GitHub PR run 验证托管环境行为**。

### P1-3：后端可无认证绑定公网/局域网——已降低风险

审查前 `--host 0.0.0.0` 可直接暴露无认证的翻译与任务接口。CORS 只约束浏览器，不是 API 身份验证。

整改：默认拒绝非 loopback 地址；只有明确传入 `--allow-remote` 才允许启动，并在帮助文本中说明必须位于可信、带认证和 TLS 的反向代理后。新增 IPv4/IPv6 loopback 与拒绝非 loopback 的单元测试。

状态：**本地产品边界已修复**。若将来正式支持远程部署，仍必须实现服务自身的 token/mTLS/身份绑定，不能把 `--allow-remote` 当作认证。

### P1-4：请求、参数、任务和子进程资源无硬上限——已修复主要风险

整改：

- `vtt_text` 最大 5,000,000 字符。
- API key、model、endpoint、target 及 provider 模式字段均有字符串长度上限；`concurrency <= 256`、`retries <= 10`、单请求 `timeout <= 600`、`repair_concurrency <= 64`，其余批量参数也设置宽松但有限的上界。单条字幕若超过 `max_chars` 会直接返回类型化输入错误，不再把超大单条偷偷塞入批次。
- FastAPI 与 MV3 直连任务都最多接受 4 个 queued/running job，超过返回 429；同步 `/translate` 与异步 worker 共享同一个 4 槽 semaphore，不能再通过同步接口绕过全局进程上限。
- 字幕资源 fetch 强制 HTTPS，使用 `no-store`、20 秒超时和 5,000,000 字节上限；响应按流读取，无 `Content-Length` 时也会在越界后立即取消 reader，不再先把整个响应载入内存。该逻辑复用于内容脚本和 Service Worker，而不是维护两套边界。
- 页面字幕源发现使用一个共享的 12 秒总预算，track、transcript-file、候选扫描及跨 Service Worker 读取都只能消耗剩余时间，避免多个 20 秒子请求串联突破外层时限。
- 在线 provider 响应限制为 4 MiB，后端代理与 translator stdout 结果限制为 64 MiB；越界会返回明确的不可重试错误，不会先无界载入内存。
- 缓存最终写入改为同目录临时文件 + `os.replace` 原子替换；临时文件尽力设置 Unix `0600`。
- translator `--help` 能力探测增加 10 秒硬超时；浏览器直连和本地 translator 整任务默认 deadline 均为 8 分钟，`TRANSLATOR_TASK_TIMEOUT_SECONDS` 只能在 30–480 秒之间配置。前端后端轮询保留 9 分钟窗口，使进程回收后的类型化错误有时间返回，避免客户端先放弃而子进程继续占槽；单次后端 HTTP 请求另有 AbortController 时限，避免一次轮询永久卡住。
- POSIX translator 在独立 session/process group 中启动，超时或读取异常时先终止整个进程组，等待后再强杀；Windows 使用进程终止并以 `taskkill /T /F` 回收子树。返回类型化 `TRANSLATOR_PROCESS_TIMEOUT/504`；stdout 诊断仍只保留最近 2,000 行。

残余：尚无面向用户的显式取消 API；它应和可恢复 job store、ownership 一起设计。当前 deadline 回收路径已有单元测试，仍应在后续 worker/job 集成测试中加入真实卡死子进程与重启场景。

### P1-5：Python/后端 DeepL 默认 endpoint 实际未生效——已修复

`provider_defaults("deepl")` 虽声明 `https://api-free.deepl.com/v2/translate`，CLI 主流程却把空 `args.endpoint` 原样传给 `requests.post`。浏览器直连正常，本地后端/CLI 会失败。

整改：抽出并测试 `resolve_provider_endpoint()`；省略 endpoint 时应用 provider 默认值，同时保留 OpenAI/DeepSeek/Gemini 规范化。远程 endpoint 必须使用 HTTPS，HTTP 只允许 loopback 开发地址，且拒绝 URL credentials。

状态：**已完成并有回归测试**。

### P1-6：Service Worker 消息与后端代理边界过宽——已修复主要部分

审查前消息 listener 忽略 `sender`，`proxy-request` 可接受任意 path/method/header，并在固定后端请求中注入存储的 provider key。

整改：

- 新增可独立测试的 `background_contracts.js`。
- 校验 `sender.id` 必须是当前扩展 ID。
- 代理只允许 `/health` GET、`/translate` POST、`/translate-async` POST、`/translate-async/{safe_job_id}` GET。
- 不再接受调用者自定义 header。
- manifest 显式声明 `script-src 'self'; object-src 'self'` CSP。
- 新增消息契约测试，覆盖路径穿越样式输入、错误 method、其他扩展和缺失 sender。

残余：job 还没有绑定 tab/session nonce；如果将来出现多个互不信任的扩展内部调用上下文，应继续实现 job ownership。

### P1-7：混合模式把失败“文本行数”误当作“cue 数”——已修复

一个 WebVTT cue 可以包含多行文字。原实现的 `metrics.failed` 统计失败文本行，而 fallback 定位集合使用 cue 序号；当同一 cue 的两行都失败时，数量比较会误判为定位信息不完整，从而跳过本应执行的混合 provider 修复。

整改：直连翻译结果新增去重后的完整 `failed_cues`，与仅用于 UI/诊断且会截断的 `failed_items` 分离；混合调度优先按 `failed_cues` 做回退映射。回归测试覆盖“两条失败文本行属于同一个 cue”并验证备用 provider 成功修复。

状态：**已完成并有回归测试**。

### P1-8：Argos 安装约束与本地测试解释器失真——已修复

`argostranslate==1.11.0` 的包元数据要求 `stanza==1.10.1`，而工作树一度把 Argos requirements 固定为 `stanza==1.12.2`，干净环境无法解析。同时旧的 `test-python.mjs` 会优先选中仓库残留的 Python 3.9 构建 venv，即使项目已声明 Python 3.10+，也不核验安装依赖是否与 `backend/requirements.txt` 的精确版本一致。

整改：恢复兼容的 `stanza==1.10.1`；测试启动器现在要求 Python 3.10+，逐一核对 FastAPI/Uvicorn/requests 的已安装版本与 requirements 完全一致，并支持通过 `ECHO360_TEST_PYTHON` 明确选择验收解释器。CI 同时执行 `pip check` 和固定版本的 `pip-audit`。

状态：**已完成**。本机包元数据复核确认 Argos 的 stanza 约束为精确 `1.10.1`；托管 CI 仍需由下一次 PR/push 首次实跑确认。

### P2-1：跨层协议重复与目标语言漂移——已修复已知缺陷，根因仍在

`provider`、target、错误码、VTT/metrics 校验分别存在于 JS UI、client、background、Python backend 和 translator。`CANTONESE` 曾在边界中被接受，却不在 UI canonical options 中，旧配置会在设置页静默回退到 `ZH`。

整改：所有已识别边界把兼容别名 `CANTONESE` 规范化为 canonical `YUE`；缓存签名也统一，避免同义配置产生两个缓存。后台路由和 target 规范化中的可复用逻辑移入 `background_contracts.js`。

状态：**已修复当前漂移**。长期仍应建立版本化 JSON Schema/协议源，并生成 JS/Python 常量；用跨语言 fixtures 验证 provider、target、error、metrics 和 VTT 语义 parity。

### P2-2：核心 god module——未进行高风险大拆分

本次没有把数千行模块机械切文件，因为当前工作树同时包含大规模混合翻译改动，盲目拆分会扩大回归面且无法证明架构边界正确。

建议顺序：

1. `backend/app.py` 先提取 `contracts/models.py`、`vtt/validation.py`、`translation/process.py`、`jobs/store.py`、`api/routes.py`。
2. `background.js` 继续把纯契约、安全检查、缓存和 job store 分离；本次 `background_contracts.js` 是第一步。
3. `direct_translator.js` 分为 adapter registry、endpoint/auth、rate policy、batch engine。
4. `controller.js` 分离手动流程、翻译会话、surface coordinator。
5. 每一步只移动一个职责，先补 characterization test，再移动，再比较行为。

状态：**未完成，P2 路线图**。

### P2-3：经典脚本顺序是隐式 ABI——已增加防漂移门禁

内容脚本和 background `importScripts()` 依赖手工顺序。审查前 syntax check 只验证单文件语法，不能发现 manifest/HTML/importScripts 引用缺失。

整改：新增 `scripts/validate-extension-structure.mjs`，验证 manifest、HTML、本地资源、background imports、重复脚本、MV3、CSP，以及 MAIN/ISOLATED assessment guard 完全一致；加入 `npm run check` 和 CI。

残余：它仍不是完整浏览器 bootstrap/E2E。长期应使用 ES module/bundler 显式依赖，或至少从单一清单生成 manifest、background imports 和测试加载顺序。

### P2-4：覆盖率报告隐藏关键零覆盖文件——已修复

审查前 `coverage.all=false` 只展示测试实际加载的文件，并用不存在的 `npm run test:mutation`/Stryker 注释暗示分支保障。

整改：升级并重命名配置为 `vitest.config.mjs`，删除失效承诺；现在所有 `extension/**/*.js` 都进入分母。设置门禁：statements 65%、branches 50%、functions 65%、lines 65%。

当前真实覆盖率：statements 66.59%、branches 54.39%、functions 70.01%、lines 69.19%。`background.js`、`popup.js`、`video.js` 仍是最明显覆盖缺口；新抽出的 `background_contracts.js` 为 100% statements/functions/lines、80.95% branches，其安全关键路由、sender 与别名均有直接测试；共享流式大小限制也有直接测试。

### P2-5：依赖与供应链——已大幅改善，保留明确例外

JavaScript 基线 `npm audit`：5 个漏洞（1 high、4 moderate）。整改为 Vitest/coverage provider 4.1.11 并更新传递依赖后，`npm audit --audit-level=moderate` 为 0。

Python runtime 基线审计：12 个漏洞、4 个包，涉及旧 requests/Starlette/urllib3/click。由于安全版 FastAPI/Starlette 已不再支持 Python 3.9，本次将最低版本调整为 Python 3.10，并固定 FastAPI 0.141.1、Uvicorn 0.52.4、requests 2.34.2；实际测试环境解析为 Starlette 1.6.0。安装后的 Python 3.13 runtime path 审计只报告测试环境自身的旧 `pip`，未报告应用 runtime 包漏洞。

CI 现在用 `pip-audit==2.10.1` 检查 Python runtime 依赖，并在 Python 3.10/3.13 矩阵中先执行 `pip check`。本机最终验收确认 requirements 中三个直接 runtime 包版本精确匹配，且 `pip check` 无断裂依赖。

完整 Argos/PyInstaller 打包栈仍固定 `torch==2.2.2`，原因是后续 PyTorch 不再发布 Intel macOS wheel。基线完整栈审计包含大量 PyTorch 公告。不能在保持 macOS Intel 打包承诺的同时盲目升级；这是**已知且未接受为“已修复”**的供应链风险。应尽快决定：停止 Intel macOS 构建并升级 PyTorch，或隔离可信模型/输入、维护平台专用 lock 与安全例外到期日。

新增 `.github/dependabot.yml`，覆盖 npm、pip 和 GitHub Actions。Python 仍缺完整 transitive hash lock/SBOM；发布前应使用 `pip-compile --generate-hashes`、uv lock 或等价机制。

### P2-6：敏感 URL 与 provider endpoint——已降低风险

- 浏览器与 Python provider 请求均拒绝远程明文 HTTP；loopback 开发除外。
- 渲染进页面 DOM 的 `data-echo360-source-id` 改为脱敏 URL，不再复制签名 query/token。
- 字幕 fetch 使用 `cache: no-store`，但 Google Web 非官方 GET API 仍会把单条字幕放入 query；该接口协议本身决定了残余隐私留存面，应在隐私文档中持续明确说明，且不要记录完整 URL。
- `optional_host_permissions` 的 `https://*/*` 仍然较宽，但当前任意自定义 HTTPS 后端功能需要用它作为声明上界；实际保存时只请求用户填写的精确 origin。若产品不再需要任意 custom backend，应删除该通配能力。

### P2-7：发布产物完整性——未完成

当前包仍未配置 Windows Authenticode、Apple Developer ID notarization、正式 GitHub Release checksum/provenance。README 已说明 artifact 用于测试/内部发布。本次固定 Action SHA 和改进 cache key，但这不替代产物签名。

状态：**公众分发前必须完成**。

### P3：仓库卫生——已改善

- 新增 `.editorconfig`、`CONTRIBUTING.md`、`SECURITY.md`。
- `npm run check` 现在包含 Python 测试、扩展结构检查和文档对齐检查；文档门禁验证本地链接、README/manifest 版本、后端安全入口及隐私/商店关键合同。
- 清除 package lock、测试和配置文件误设的 executable bit。
- 保留 assessment guard 双副本，但结构门禁会阻止两份漂移。长期可由构建脚本从一个 canonical source 生成。

## 5. 最终验证结果

| 检查 | 结果 |
|---|---|
| JavaScript/Python syntax | 通过：50 个 JavaScript、6 个 Python 文件 |
| 扩展结构/CSP/资源引用 | 通过：63 个引用文件 |
| 文档链接与关键合同对齐 | 通过：12 个 Markdown 文件，版本/启动/隐私/商店声明一致 |
| Vitest | 通过：34 个文件，604 个测试 |
| Python 3.13.9 + 精确 runtime 依赖 | 通过：48 个测试；FastAPI 0.141.1、Uvicorn 0.52.4、requests 2.34.2 |
| Python 依赖一致性 | 通过：`pip check` 无断裂依赖；测试启动器拒绝旧 Python/错误依赖版本 |
| 覆盖率与阈值 | 通过：66.59 / 54.39 / 70.01 / 69.19 |
| Chrome store/dev 构建 | 通过 |
| Safari 资源同步/一致性 | 本机已生成 Xcode 工程通过：49 个生成文件，两个目标各 46 个顶层资源；干净 Linux CI 中该平台检查会明确跳过 |
| npm 依赖审计 | 通过：0 vulnerabilities |
| `git diff --check` | 通过 |

最终复审逐项核对了本次整改的入口与退出条件：FastAPI 的 8 分钟子进程 deadline 小于前端 9 分钟后端轮询窗口；浏览器直连也有同等整任务 deadline；字幕源扫描共享 12 秒预算；同步/异步翻译共享后端进程槽；POSIX/Windows 超时路径回收进程树；provider、后端和 translator 输出都有流式/读取上限；新增错误码在后端 problem detail、扩展规范化与用户提示中闭合；源码启动文档使用会拒绝非 loopback 的 launcher；README 中英文、隐私政策、商店清单、贡献与安全指南已与 manifest、代码路径和质量门禁对齐。未发现需要阻止本次交付的新增缺陷。

没有执行真实 provider 付费 API 请求、真实 Chrome/Safari 页面端到端操作、Windows/macOS PyInstaller 全矩阵打包、签名/公证或 Service Worker/后端进程重启恢复测试。因此不能把本报告解读为这些场景已经验收。

## 6. 后续工作优先级

### 第一阶段：必须优先

1. 实现可恢复 job store、固定 worker pool、job ownership、显式取消与重启恢复；加入真实卡死子进程/僵尸进程集成测试。
2. 增加真实 `background.js` worker harness 与 worker reload 集成测试；优先覆盖创建、进度、权限、失败和恢复。
3. 解决 PyTorch 2.2.2 与 macOS Intel 支持冲突，形成有到期日的风险决定。

### 第二阶段：可维护性

1. 分阶段拆分 `backend/app.py`、`background.js`、`direct_translator.js`、`controller.js`、`error_utils.js`。
2. 建立单一版本化协议源并生成 JS/Python contracts；增加跨语言 parity fixtures。
3. 为 `video.js`、`popup.js` 和完整 content-script bootstrap 补测试，将覆盖率阈值逐步抬高。
4. 建立完整 Python hash lock、SBOM 和依赖例外记录。

### 第三阶段：正式发布

1. Windows Authenticode、Apple Developer ID 签名/公证。
2. checksum、SBOM、provenance、正式 Release workflow。
3. 真实 Chrome/Safari、Canvas/Echo360、多网络状态和长字幕 E2E 矩阵。

## 7. 最终判断

整改后的项目结构在顶层是清晰、有逻辑的，复用和工程门禁较审查前明显改善，当前修改通过了与风险相称的自动验证。它已经符合许多日常软件工程最佳实践，但**仍不能称为完全完成或完全符合行业最佳实践**：易失异步任务、超大核心模块、PyTorch 残余漏洞和未签名发布链是明确、可追踪且必须继续处理的例外。

最合理的维护策略不是继续在现有大文件里堆补丁，而是以“先 characterization tests、再一次迁移一个职责”的方式执行上述路线图，并把每一阶段的 CI、覆盖率和重启/故障测试作为完成条件。
