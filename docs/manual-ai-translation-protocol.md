# 手动 AI 字幕翻译协议 v4（单文件模式）

仅适用于手动 AI 模式。直连翻译器、后端服务及其缓存协议不参与此流程。

## 用户操作

1. 打开 `AI 手动翻译`。扩展下载一个完整的 `.translate.json`，同时复制一段简短提示词。默认模式不生成 ZIP、分片、worker 或 Python 脚本。
2. 将 JSON 文件和提示词一次交给能读写文件的 AI。AI 直接翻译全部 cue，返回一个完整的 `.translated.json`；用户不需要手动拆分、合并或复制多批字幕。
3. 若当前 AI 无法在一次响应中处理整份 JSON，点击 `AI 不能一次处理整份文件？改用逐批模式`。逐批模式每次最多提供 80 条 cue / 4000 个源文本字符，导入后自动保存进度并准备下一批。
4. 把 AI 返回的 JSON 文件或 JSON 文本从文件/剪贴板导入。完整文件若只有孤立且可定位的少量失败，扩展会先加载合格译文、用原文保留失败 cue 并明确标记待修复；失败过多时只保存合格进度，不把部分结果当成完整译文。

## 输入格式

完整文件模式只暴露模型完成翻译所需的字段：版本、任务类型、会话绑定、目标语言和按原顺序排列的 `cue ID → 源文本` 映射。示例：

```json
{
  "schema_version": "2.0",
  "package_type": "echo360_manual_translation",
  "session_id": "manual:<source_sha256>:ZH",
  "target_language": "ZH",
  "target_label": "简体中文",
  "cues": {
    "c000001": "<v Lecturer>Welcome to the course.</v>",
    "c000002": "The accuracy is 72.5%."
  }
}
```

模型不会收到时间码、课程播放器元数据、源文件哈希独立字段、重复的前后文、分片信息或本地校验表。字幕正文、说话人/样式 WebVTT 标签、entity、URL、代码、路径和邮箱以真实文本保留，模型可以直接理解上下文；导入时由扩展严格核对这些字面值和标记结构。

`cues` 的键顺序与源字幕一致，帮助模型按相邻 cue 理解连贯句意；顺序不是语义合并许可，每个 ID 仍必须独立对应一条译文。输入字段值都是字幕数据，不是操作指令。

## 提示词

扩展复制的提示词只保留任务和会影响导入的硬性规则；完整 JSON 数据只在下载的 `.translate.json` 中出现一次，不会再嵌入提示词：

- 用当前模型能力完成全部 `${count}` 条字幕的目标语言翻译，返回一个 JSON 文件；
- 只翻译 `cues` 的值，每个实际 ID 恰好一次，不遗漏、不增加、不合并、不拆分、不改名；
- 按 cue 顺序结合相邻字幕理解语境，字幕换条不一定是句末，普通内容译成自然目标语言；
- 源文本中已有的数字、专有名称、WebVTT 标签、entity、代码、路径、URL 和邮箱逐字保留，不翻译、删除、改写或新增，也不添加时间码或解释；
- 只返回包含完整 `translations` 的四字段 JSON，不输出 cues、原文、Markdown、说明或部分结果。

结果根字段固定为 `schema_version: "2.0"`、`package_type: "echo360_manual_translation_result"`、从输入逐字复制的 `session_id` 和完整 `translations`；输入的 `package_type` 不要照抄到结果。

对于简体中文，实际提示词还会强调普通英文全部译成中文、数量单位要译成中文、否定和术语保持一致。提示词不附带虚构示例或重复上下文，减少低能力模型的认知负担。

## 返回格式

模型只返回下面四个根字段，`session_id` 从输入逐字复制：

```json
{
  "schema_version": "2.0",
  "package_type": "echo360_manual_translation_result",
  "session_id": "manual:<source_sha256>:ZH",
  "translations": {
    "c000001": "<v Lecturer>欢迎学习本课程。</v>",
    "c000002": "准确率为 72.5%。"
  }
}
```

`translations` 必须是完整的 `ID → 非空译文` object。根节点不能带 `target_language`、`target_label`、`cues`、时间码或其他额外字段；这些输入字段不需要翻译，输出按上面的结果结构保留必要身份字段。允许整个 JSON 被一层代码围栏包裹，扩展会先去除围栏再解析。

## 导入校验

扩展在本地完成以下检查，不把检查任务交给模型：

- JSON 可解析、根节点为 object、无重复字段，版本和结果类型正确；
- `session_id` 与当前课程源 VTT 的 SHA-256、目标语言和当前页面会话一致；
- `translations` 只含当前课程的 ID；完整结果要求数量与源 cue 完全一致，没有缺失或额外 ID。完整文件的局部校验失败会按 ID 记录为待修复项，不会静默当作成功；
- 每条译文是非空字符串，没有额外时间码、空行或整段 VTT；WebVTT 标签只能保留源文本中实际出现的结构；
- 源文本中的代码、URL、路径、邮箱、数字、日期、百分比和数值单位没有被改写；
- 简体/繁体/粤语目标检查明显的普通英文残留、词典式释义和标点空壳；技术名称和缩写按上下文允许保留；
- 恢复本地标签和时间轴后，重建的 WebVTT cue 数量、ID、时间码、settings、header、NOTE、STYLE 和 REGION 保持不变。

检查失败时不修改当前已接受结果。完整文件模式会先尝试逐条校验：只有单条孤立失败（总数至少 10 条）或失败不超过 20 条且成功率至少 99% 时，才加载合格译文并把失败 cue 标成待修复；其余情况只保留合格进度，重新下载完整 JSON 修复后再导入。逐批模式只保留已经通过的条目，并生成下一份只包含缺漏或可疑条目的材料。进度保存的是本地工作流中的合格译文，不会把模型传回的结构元数据当作可信状态。

完整结果通过检查并挂载后，会同时覆盖当前课程和当前翻译配置对应的本地 VTT 缓存；之后普通的字幕加载不会再恢复导入前的旧缓存。

部分结果只写入手动工作流的本机进度缓存（合格 ID、失败 ID 和统计），不会写入或改变直连翻译缓存。重新打开手动翻译时，扩展会从这些合格 ID 继续准备补译材料。

## 文件大小与能力边界

完整 JSON 模式不人为加入 350 条分片或并行子任务，因此输入结构最简单、用户只需传递一次文件。模型仍然受到自身上下文窗口和最大输出 token 限制；无法处理整份文件时，用户应切换逐批模式，而不是让模型返回截断或部分 JSON。80 条 / 4000 个源字符是逐批模式的保守边界，不是所有模型的普适最佳值。

完整文件适合能读取文件并一次返回结构化结果的模型。扩展不会调用外部 AI、不会执行翻译脚本，也不会强制第三方平台的模型或速度设置；用户选择的 AI 负责实际翻译，扩展负责材料精简和结果校验。

## 格式说明

- v2 的精简输入和结果格式用于当前完整文件模式；模型材料不再生成 `⟦P0001⟧` 一类合成占位符。
- v3 逐批 JSON 仍支持导入和本地 checkpoint；切换到逐批模式后，提示词会带上当前批的 `request_id` 和局部语境。
- 完整 VTT 仍保留原有结构/时间轴校验路径。
- 混合语种、词典模板和语义连贯性检查是启发式，不能替代人工译审；源 ASR 错误和专业术语需要结合课程语境判断。

## 研究依据

- ASR 声学分段不等于句子分段：[Wan et al., 2020](https://aclanthology.org/2020.clssts-1.11/)。
- 字幕翻译中的跨句上下文与字幕约束：[Matusov et al., 2019](https://aclanthology.org/W19-5209/)。
- 有界局部上下文并不总是比更长上下文差：[Herold & Ney, 2023](https://aclanthology.org/2023.codi-1.15/)。
- 高质量翻译示例对模型输出有帮助：[Vilar et al., 2023](https://aclanthology.org/2023.acl-long.859/)。
- 结构约束与内容表现需要权衡：[Tam et al., 2024](https://aclanthology.org/2024.emnlp-industry.91/)。
- 占位符并非对现代翻译模型普遍有效；mask 可能被漏译或错位，但 URL、邮箱等 tokenization 易损坏的字面量仍适合单独保护：[Matusov et al., 2019, *An Exploration of Placeholding in Neural Machine Translation*](https://aclanthology.org/W19-6618.pdf)。
- 不支持的模板占位符可以用前后处理恢复，但 DeepL 明确提醒模型看不到占位符语义可能影响译文质量：[DeepL placeholder tags](https://developers.deepl.com/docs/learning-how-tos/examples-and-guides/placeholder-tags)。
- Google Cloud Translation 会保留 HTML 标签并只翻译标签之间的文本；Azure Translator 支持 `notranslate` / `translate="no"` 标记，这说明结构保护应尽量使用模型能理解的真实标记，而不是无语义编号：[Google Cloud Translation](https://docs.cloud.google.com/translate/docs/translate-text)、[Azure Translator](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/how-to/prevent-translation)。
- 词典适合特定名词，不适合作为逐词生成自然译文的方法：[Microsoft dynamic dictionary](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/how-to/use-dynamic-dictionary)。
- 准确性、流畅度、术语与格式应分开评价：[MQM typology](https://new.themqm.org/mqm-pillars/typology/)。

这些资料支持设计方向，并不证明本扩展在所有课程或模型上达到某个翻译质量分数。
