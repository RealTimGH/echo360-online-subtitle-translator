# Argos 本地翻译替代方案调研

调研日期：2026-09-09

## 结论

对本项目这种“英语课程字幕 → 指定目标语言、CPU 优先、离线、桌面安装包”的场景，下一步最值得做的是 **Bergamot/Marian 语言对模型的可插拔试验后端**，而不是立刻把 Argos 换成一个单体多语言大模型。

原因是 Bergamot/Marian 的架构本来就面向浏览器/桌面 CPU 推理，支持量化、短文本批处理和按语言对下载；Firefox Translations 也持续使用 Bergamot 运行时和专用语言对模型。它更接近本项目的部署约束。缺点是每个语言对的覆盖、模型质量和许可证都必须逐项核对，不能假定“Bergamot”三个字天然代表所有语言都优于 Argos。

在没有本项目真实 `en→zh` / `en→zh-Hant` 课程字幕基准前，**本次不静默替换已发布的 Argos 模型**。仓库先修复 Argos 启动可靠性、恢复自定义后端，并保留清晰的 provider 路由边界；下一步可以通过“自定义后端”接入 Bergamot 原型做 A/B 测试，不影响现有用户。

## 能比 Argos 好多少

目前能找到的最直接公开同场比较来自 TranslateLocally 论文的 WMT19 英译德实验。同一表格中：

| 系统 | 模型大小 | BLEU | 吞吐量 |
| --- | ---: | ---: | ---: |
| Argos Translate | 87 MB | 34.9 | 76 words/s |
| Bergamot tiny | 15 MB | 41.8 | 7,350 words/s |

在这个**特定旧基准、特定语言对和论文测试硬件**上，Bergamot tiny 相对 Argos 是：

- `+6.9 BLEU`，约 `+19.8%` 的相对 BLEU 提升；
- `7,350 / 76 ≈ 96.7×` 的吞吐量；
- 模型文件约小 `82.8%`。

这组数字足以说明 Bergamot 路线值得优先验证，但不能外推成“中文课程字幕也一定提升 6.9 BLEU / 快 97 倍”。字幕断句、专有名词、短 cue 上下文、简繁体输出和模型版本都会改变结果。发布替换前应使用本项目真实数据集测 COMET、chrF、术语准确率、cue 完整率、CPU 首包延迟、峰值内存与包体。

## 候选方案

### 1. Bergamot / Marian：首选试验方案

- Bergamot 是面向浏览器的 Marian NMT 运行时，重点优化客户端 CPU 推理；Firefox 的本地翻译架构使用它。
- 语言对模型可以独立选择和量化，包体与内存更容易控制；Mozilla 维护的模型注册表和仪表板包含语言对及 BLEU/chrF/COMET 等元数据，可作为选型入口。
- Bergamot-translator 本身使用 MPL-2.0；模型是独立作品，发布前仍需逐个审计模型卡/注册表给出的许可证。
- 截至本次调研，Mozilla 当前 gen 3.x 发布权重没有明确许可证字段的问题仍有公开 issue 跟踪。因此即使运行时许可证合适，也不能在许可证澄清前直接把这些权重重新打包进本项目。
- 对本项目的最佳接入方式是先做独立兼容后端，通过现有 `custom-backend` provider 接入，再决定是否进入正式打包后端。

### 2. MADLAD-400 3B：质量/覆盖优先的重型选项

- 单模型覆盖数百种语言，模型卡给出 Apache-2.0，适合希望用一个运行时覆盖大量目标语言的桌面高级模式。
- 3B 参数即使量化后仍明显重于按语言对分发的 Bergamot/Argos；启动时间、内存和安装包体更难符合普通浏览器扩展配套应用的预期。
- 可以作为高内存设备的可选 provider，不适合替代当前默认轻量本地路径。

### 3. M2M100 418M：较轻的通用多语言备选

- MIT 许可证、单模型多语言、规模比 MADLAD-400 3B 小，适合快速做广覆盖原型。
- 模型较旧；在课程字幕、中文术语和现代专名上不能仅凭论文基准假定优于最新语言对模型，仍需本项目数据验证。

### 4. NLLB-200 / SeamlessM4T：不作为发布候选

- NLLB-200 的覆盖和研究质量很强，但常用模型卡标注 CC-BY-NC-4.0，并明确定位为研究模型而非生产部署；对可公开分发的软件不合适。
- SeamlessM4T 同样是非商业许可路线，而且包含语音能力；本项目输入已经是 VTT 文本，为无关能力承担更大体积和复杂度没有收益。

### 5. OPUS-MT / CTranslate2：组件而非单一答案

- OPUS-MT 提供大量 Marian 语言对模型，覆盖广，但质量与许可证随具体模型变化；它更适合作为候选模型来源，而不是统一的质量承诺。
- CTranslate2 是高效 Transformer 推理引擎，可转换/量化多类模型。Argos 本身已经使用 CTranslate2，因此“换成 CTranslate2”并不会自动提升质量；质量主要取决于模型、训练数据和上下文策略。

## 推荐实施路线

1. 从 Mozilla 模型注册表挑选许可证可分发的 `en→zh` 与 `en→zh-Hant` Bergamot/Marian 模型；若缺少合格语言对，不勉强替换。
2. 建立去标识化课程字幕测试集，至少覆盖讲授句、公式/代码、专有名词、多人说话、短 cue、跨 cue 指代和噪声转录。
3. 用同一硬件比较 Argos 与候选模型：COMET/chrF、人工偏好、术语准确率、未译率、首包/整课耗时、峰值内存、模型与安装包体。
4. 先以兼容自定义后端形式灰度；达到预先设定的质量和资源门槛后，再把新的 provider/运行时加入打包流程。
5. 将模型来源、版本、哈希和许可证写入构建 manifest；禁止运行时静默下载或自动换模型。

## 主要来源

- [TranslateLocally: Blazing-fast translation running on the local CPU（论文 PDF）](https://www.kheafield.com/papers/edinburgh/translatelocally.pdf)
- [Bergamot Translator 官方仓库](https://github.com/browsermt/bergamot-translator)
- [Firefox Translations：Bergamot 技术文档](https://firefox-source-docs.mozilla.org/toolkit/components/translations/resources/03_bergamot.html)
- [Mozilla Translations 模型仓库](https://github.com/mozilla/translations)
- [Mozilla Firefox 翻译模型仪表板](https://mozilla.github.io/translations/firefox-models/)
- [Mozilla 当前模型权重许可证澄清 issue](https://github.com/mozilla/translations/issues/1434)
- [MADLAD-400 论文](https://arxiv.org/abs/2309.04662)
- [MADLAD-400 3B MT 模型卡](https://huggingface.co/google/madlad400-3b-mt)
- [M2M-100 论文](https://arxiv.org/abs/2010.11125)
- [M2M100 418M 模型卡](https://huggingface.co/facebook/m2m100_418M)
- [NLLB-200 distilled 600M 模型卡](https://huggingface.co/facebook/nllb-200-distilled-600M)
- [SeamlessM4T v2 large 模型卡](https://huggingface.co/facebook/seamless-m4t-v2-large)
- [OPUS-MT 官方仓库](https://github.com/Helsinki-NLP/Opus-MT)
- [CTranslate2 官方仓库](https://github.com/OpenNMT/CTranslate2)
