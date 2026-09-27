# 缓存、异步任务与状态一致性

本次修复由具体竞态和错误路径驱动；没有改变翻译算法、提供商配额或用户现有 API Key。

| 已确认问题 | 修复语义 | 回归测试 |
| --- | --- | --- |
| 跨页面整表写入丢失缓存更新 | 后台唯一写入者串行处理读取、触碰、写入和删除；消息失败不退回页面自行写表 | shared_storage、storage 单元/属性测试 |
| 同一手动会话的进度快照相互覆盖 | cue 级合并；以调用方上次观察的原始存储值判定冲突，允许修复被校验过滤的坏译文，冲突保留先提交的新值；合并响应再次校验译文，恢复与合并一致检查有效期 | shared_storage、manual_translation |
| 固定 URL 下字幕更新仍命中旧译文 | 缓存身份始终包含原始字幕 SHA-256；合并模式与原文共享源身份 | translation_service |
| 完整手动导入被旧合并缓存或在途机器结果覆盖 | 原子失效同源同配置的两种模式；拒绝迟到机器写入并返回权威手动结果用于渲染 | shared_storage、controller |
| 异步回调恢复旧显示设置 | 渲染时读取最新显示偏好，保留请求自己的源和目标语言；待保存的新本地编辑优先于旧保存通知，维护读取过期时使用最新快照 | controller |
| 停止轮询没有停止后台工作 | AbortSignal 贯穿请求、退避和限速；后台验证任务所属页面；本地后端取消任务、终止子进程并释放并发槽 | direct_translator、backend_client、background_jobs、Python 取消测试 |
| Transcript 异步布局在 clear/hide/替换后访问旧模型 | 渲染代次与模型、面板身份检查；能力握手、布局提交及搜索滚动的延迟响应均重新校验，旧滚动失败不会禁用新模型的布局 | transcript_panel_renderer |
| 损坏 UTF-8 缓存使后端翻译失败 | 捕获读取/解码错误，跳过损坏缓存重新翻译 | Python CacheConcurrencyRegressionTests |
| 临时参数探测失败永久缓存为空集合 | 仅缓存成功探测，异常不进入 lru_cache | Python CacheConcurrencyRegressionTests |
| 多线程熔断窗口时间顺序倒置 | 同一临界区内读取单调时钟并修改窗口 | Python CacheConcurrencyRegressionTests |
| 销毁后等待中的 init 重新安装界面和监听器 | 初始化代次检查 | controller |
| MV3 重启丢失内存任务 | 有界、无凭据的恢复日志；完成结果可读取，未完成任务明确中断，保留可用预览，不自动重放请求 | job_journal、background_jobs |

手动进度沿用原设计，只保留最近课程；不同课程不合并。同 cue 的冲突保留先提交的新值，不声称同时保留两个不同版本。

恢复日志受存储配额、TTL、字符上限和写入完成情况影响。它不是提供商事务日志，不保证网络请求恰好执行一次。中断后的手动重试可能重新翻译，未知响应不能视作已确认译文。自定义旧后端可能缺少 DELETE 接口，取消失败会记录诊断；本仓库后端支持该接口。远端已接收请求的计费由提供商决定。

## 参考方法

- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)：多上下文共享异步存储；项目使用后台唯一写入者保护复合读改写。
- [Chrome service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)：后台停止会丢失全局变量，重要状态应持久化。
- [MDN AbortController.abort](https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort)：取消请求和响应体读取；项目也让等待队列和重试计时器响应取消。
- [MDN AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal#implementing_an_abortable_api)：支持取消的异步 API 同时检查已经取消的信号并监听后续取消，覆盖请求前与请求中的取消。
- [React useEffect 异步竞态清理](https://react.dev/reference/react/useEffect#fetching-data-with-effects)：过期响应不能提交当前界面；项目采用框架无关的代次与身份检查。
- [Python functools](https://docs.python.org/3/library/functools.html#functools.lru_cache)：仅缓存成功计算，暂时失败保留为异常以允许重试。
- [Python Lock objects](https://docs.python.org/3/library/threading.html#lock-objects)：共同保持不变量的时间采样与窗口修改放在同一临界区。

## 验证方式

项目完整检查命令：

```sh
ECHO360_TEST_PYTHON=/tmp/echo360-test310-audit/bin/python npm run check
```

Python 验证环境由 conda test310 的 Python 3.10 创建隔离 venv，安装 backend/requirements.txt 的固定依赖，不修改原 conda 环境。JavaScript 测试覆盖真实后台消息分发以及模拟存储、网络和页面竞态；Python 测试覆盖后端任务终态、取消与缓存错误。自动化没有调用付费翻译 API，也不能替代真实 Echo360 浏览器会话的端到端验证。

2026-09-27 二次审查补充：显示设置的两个新增竞态测试、旧滚动请求失败污染新模型布局的测试，均已通过暂时撤回对应修复验证确实失败，再恢复修复验证通过；Transcript 另增加 clear/hide/替换模型期间延迟布局确认的三个回归场景。

本轮最终完整检查通过：41 个 JavaScript 测试文件、855 项测试；Python 3.10.21 下 71 项测试，固定依赖为 fastapi 0.141.1、uvicorn 0.52.4、requests 2.34.2。语法、扩展结构、文档、store/dev 构建、Safari 资源同步与校验均通过。此次新增 11 个 JavaScript 回归场景。
