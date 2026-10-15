# 第三方组件、模型与服务说明（THIRD-PARTY）

本文件记录本项目**依赖、调用或参考**的第三方内容及其许可归属。
本项目自身的许可结构：**代码 = MIT**（[LICENSE](LICENSE)），**美术素材 = 单独许可**（[ART-LICENSE.md](ART-LICENSE.md)）。

> 标注「**待核实**」的条目，表示作者尚未取得可引用的官方许可原文。此类条目只记录事实与出处，
> **不代表作者对其许可范围作出任何承诺或扩大解释**；一律以各上游项目的官方条款为准。
>
> 记录原则：**「生成模型的输出许可」与「生成服务的分发许可」是两条彼此独立的授权**。
> 本文件分别记录，不互相替代，也不因其中一条成立就推定另一条已获授权。

## 结论分级（本文件每行的标签含义）

| 级别 | 含义 | 判定依据 |
|---|---|---|
| **A｜官方许可证文本已查阅** | 作者已取得并可引用上游**官方**许可原文 | 官方仓库 / 官方站点上的 LICENSE 或条款页（附 URL） |
| **B｜本项目实际依赖情况已核实** | 已在本机或本仓库实测确认：版本、调用位置、是否随发布物分发 | 本机文件与元数据实测、`package.json` 的 `files` 白名单 |
| **C｜本项目具有分发授权** | 作者已取得可**直接分发**该组件的明确授权依据 | 权利人书面许可 / 许可文本中明确的再分发条款 |

**三者互不蕴含**：A 不蕴含 B（读过条款不等于这个版本的用法合规），A 与 B 都**不蕴含** C（用法清楚不等于有分发权）。
下表中凡未达到某级别者，一律如实标注。

## 1. 运行平台：DeepSeek Harness（DSH）

| 项 | 内容 |
|---|---|
| 关系 | 本插件是 DSH Web UI 的插件，通过 slot（`shell.overlay`、`conversation.session.header.actions`）挂载；不修改 DSH 自身代码，也不随本项目分发 DSH 代码 |
| 许可 | MIT —— **级别 A 已查阅**：官方仓库根目录 `LICENSE` 为 MIT 全文，版权行 `Copyright (c) 2026 DeepSeek`（21 行 / 1.04 KB，最近一次变更为 `Adopt MIT for DSH packages`） |
| 官方来源 | 仓库：<https://github.com/deepseek-ai/deepseek-harness>（默认分支 `master`）· 许可原文：<https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE> · 同一提交还包含 <https://github.com/deepseek-ai/deepseek-harness/blob/master/THIRD_PARTY_NOTICES.md> |
| 附加条款 `LICENSE.details` | **待核实**：作者报告 DSH 的 `LICENSE.details` 含 **“No Commercial Secondary Development”** 附加条款。本轮**未能取得该文件原文**：公开仓库根目录没有该文件（`master/LICENSE.details` 返回 404），本机 DSH 安装目录内也未定位到同名文件（`resources/app.asar` 在本沙箱中不可读）。因此**该附加条款对「独立发布的本插件」的适用范围保留为待确认，本文件不就此作确定性法律结论**；如上游提供该文件，应以其原文为准并重新评估 |
| 依赖情况 | **级别 B 已核实**：本插件不修改 DSH 代码、不打包 DSH 内容；本项目拟公开的 31 个文件清单中不含任何 DSH 文件（`package.json` 的 `files` 白名单为 `lib`、`cordis.patch.yml`、`README.md`） |
| 分发授权 | **级别 C 未主张**：本文件不主张「已取得随本插件分发 DSH 内容的授权」；本项目实际也不分发 DSH 代码 |

`package.json` 中的运行时依赖只有 `peerDependencies`：`@deepseek-ai/cordis` 与 `react`。
两者**不随本项目分发**，其许可以各自上游为准。**级别 A 已查阅**（依据 DSH 官方
[THIRD_PARTY_NOTICES.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/THIRD_PARTY_NOTICES.md)）：
`@deepseek-ai/cordis` 以源码 vendored 于 `vendor/cordis` 并以 MIT 重新发布（该目录保留上游 `LICENSE` 文件），`react` 列为 MIT。
**级别 B 已核实**：`lib/client.js` 只 `require('react')` 这一个平台模块（由 `art/smoke-test.cjs` 的 require 白名单断言），
未打包任何第三方 JavaScript 库。**级别 C 未主张**。

## 2. 美术素材的生成模型与服务

| 项 | 内容 |
|---|---|
| 生成服务 | NVIDIA API（`https://ai.api.nvidia.com/v1/genai/...`） |
| 服务官方来源 | **级别 A 已查阅**：《NVIDIA API Trial Terms of Service》官方 PDF —— <https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf> |
| 服务条款要点 | **§1.2（Trial Access Rights）**：NVIDIA 仅在试用范围内提供访问 —— “NVIDIA will provide you access to the API Service for **limited trial purposes only and without use of the API Service or Generated Content in production**.”；**§4.2（Restrictions）**：“Except as indicated in the Section 1.2 (“Trial Access Rights”) above, **you may not copy, sell, rent, sublicense, transfer or distribute or make available to others any portion of the API Service or Generated Content.**”；**§6.3（Ownership）**：“**A license accompanying an API Service, such as an AI model license or third-party license, may govern the ownership of Generated Content.** Unless otherwise stated in an accompanying license … you own all Generated Content that may result from your use of an API Service.”（§9 另说明随服务附带的组件适用各自许可） |
| 服务条款结论 | **不得据此认为公开分发立绘已获授权**：§4.2 明文限制「复制、出售、出租、再许可、转让、分发或提供给他人」API Service 或 **Generated Content**，§1.2 的例外仅指向试用访问权限本身，并非分发许可。作者**未取得 NVIDIA 的书面授权**，故本文件不主张已获准公开再分发立绘；本项目素材按 [ART-LICENSE.md](ART-LICENSE.md) 处理（非商业、再分发尚未授予） |
| 模型 A：FLUX.1-dev | `black-forest-labs/flux.1-dev` —— 发布物中**全部 10 张立绘**由它生成（调用见 `art/gen.py`、`art/gen-actions.py`，端点 `https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev`） |
| 模型 A 官方来源 | **级别 A 已查阅**：《FLUX \[dev\] Non-Commercial License v2.0》官方页面 —— <https://bfl.ai/legal/non-commercial-license-terms>（页面标注 **Last Revised on November 25, 2025**） |
| 模型 A 许可 | 名称与版本：**FLUX \[dev\] Non-Commercial License v2.0**，修订日期 **2025-11-25**。要点：**§1(a)** 明确 “Outputs are not considered Derivatives”；**§1(c)** 定义 Non-Commercial Purpose（个人研究/实验/爱好项目，或商业实体的非生产环境测试评估，且不得因此获得直接或间接报酬）；**§2(a)(b)** 授予的许可**仅限非商业用途**，商业用途须另行向 Black Forest Labs 申请；**§2(d)** “**We claim no ownership rights in and to the Outputs.** … You may use Output for any purpose (including for commercial purposes), except as expressly prohibited herein. **You may not use the Output to train, fine-tune, or distill a model that is competitive with a FLUX \[dev\] Model.**”；**§2(e)** 要求实施内容过滤，或在分发前对输出做违法/侵权审查，并按适用法律披露内容由 AI 生成；**§4(a)** 禁止商业/生产、军事、监控、生物识别等用途 |
| 模型 A 与本项目 | **只记录，不延伸推论**：上述 §2(d) 是对**模型输出**的条款，**不能**解除 NVIDIA API Trial Terms §4.2 对「通过该服务生成的 Generated Content」的分发限制——两条授权彼此独立，服务层面的限制并未因此解除 |
| 模型 B：FLUX.1-Kontext-dev | `black-forest-labs/flux.1-kontext-dev` —— 曾尝试图生图，因该端点在本账号上只接受预注册的 `example_id`，最终**未采用**；发布物中无其产物 |
| 模型 B 官方来源 | **级别 A 已查阅**：同一份《FLUX \[dev\] Non-Commercial License v2.0》（其 “Models” 定义明确包含 `FLUX.1 Kontext \[dev\]`）—— <https://bfl.ai/legal/non-commercial-license-terms> |
| 模型 B 与本项目 | **级别 B 已核实**：最终 10 张立绘**未使用该模型的输出**，发布物中不含 Kontext 产物；其许可要点仅作并列记录，不构成本项目的授权依据 |
| 两条授权的关系 | **模型输出许可 ≠ 生成服务分发许可**：前者约束模型产物自身的使用，后者约束「能否把生成结果公开再分发」。本文件分别记录，不把二者混同，也不用一条替代另一条 |
| 本项目立场 | 在模型与服务两条授权都核实确认之前，作者**不主张素材可自由再分发**；由此生成的立绘按 [ART-LICENSE.md](ART-LICENSE.md) 处理，**不应被视为已获准自由再分发**（该文件第 5 节列有待核实事项） |

## 3. 构建期依赖（Python，均不随发布物分发）

| 组件 | 本项目中的用途 | 许可 | 依据 |
|---|---|---|---|
| Pillow 12.3.0 | `art/build-art.py`、`art/cutout.py`、`art/gen.py`、`art/inspect_image.py` 的图像读写、画布合成与绿幕抠图 | MIT-CMU | **级别 A + B 已核实**：`pillow-12.3.0.dist-info/METADATA` 中 `License-Expression: MIT-CMU`；该依赖仅用于构建，不在发布物中 |
| numpy 2.3.5 | `art/cutout.py` 的阈值标定与 alpha 计算 | BSD-3-Clause | **级别 A + B 已核实**：`numpy-2.3.5.dist-info/METADATA` 中 `Classifier: License :: OSI Approved :: BSD License`，`LICENSE.txt` 为三条款 BSD 条文；仅用于构建 |

其它 Python 依赖：**无**（`art/gen.py`、`art/gen-actions.py` 的生图请求只用标准库 `urllib`）。

## 4. 构建期工具（Node.js，不随发布物分发）

| 组件 | 用途 | 许可 | 官方来源与结论 |
|---|---|---|---|
| Node.js | 运行 `art/smoke-test.cjs`、`art/check-patch.cjs`、`art/grep-asar.cjs`，以及 `node --check` 语法校验 | MIT | **级别 A 已查阅**：官方 `LICENSE` <https://github.com/nodejs/node/blob/main/LICENSE> —— 首段为 MIT 全文（“Copyright Node.js contributors”）；该文件同时列出随 Node.js 分发的第三方组件许可（如 OpenSSL = Apache-2.0、ICU = Unicode-3.0、V8 = BSD 类、zlib = zlib）。**级别 B 已核实**：本项目只用 DSH Desktop 自带的运行时执行构建与测试（本机实测 `v24.17.0`），**不随发布物分发任何 Node 运行时或二进制**。**级别 C 未主张** |
| js-yaml | `art/check-patch.cjs` 解析 `cordis.patch.yml` 时在构建期临时 require（**不随发布物分发**） | MIT | **级别 A 已查阅**：上游 `LICENSE` <https://github.com/nodeca/js-yaml/blob/master/LICENSE> —— “(The MIT License) Copyright (C) 2011-2015 by Vitaly Puzrin”。**级别 B 已核实**：本机实际使用副本位于 `%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\js-yaml`，其 `package.json` 为 `name: js-yaml` / `version: 4.3.2` / `license: MIT`，同目录 `LICENSE` 首行为 `(The MIT License)`、SHA-256 `A07BC24468B9654CE76A547D47A2DB282D07733B715DB4C73A98BD63961F9550`；该副本由 DSH profile 提供，且不在本项目 `files` 白名单内。**级别 C 未主张** |

三个脚本只使用 Node 内置模块（`fs` / `path`）；只有 `art/check-patch.cjs` 额外 require 了 DSH 自带的 `js-yaml`。
上表两行**均不随本项目发布物分发**；若将来打包 Node 运行时或随发布物附带 `js-yaml`，需重新评估其（及其附带第三方组件的）许可与分发条件。

## 5. 素材来源声明

- 发布物中的 10 张立绘取自 `art/src/*.png`，作者确认这些文件是**文生图产物**。
  `art/build-art.py` 内保留了「参考图裁切」兜底路径，但发布物中的素材不取自该路径。
- 生成提示词只描述角色特征（发色 / 瞳色 / 精灵耳 / 皇冠与花 / 裙装配色 / 镰刀），
  经检查 `art/gen.py` 与 `art/gen-actions.py` 的提示词文本，**未包含任何既有作品名、角色名或商标**。
- 角色形象为原创设定。作者无法保证不存在与既有作品的偶然相似，亦不对此作出担保。
- 素材按「现状（as-is）」提供，不附带任何明示或默示担保。
- 以上来源声明只陈述事实，**不构成对素材可再分发的授权**；再分发立场见第 2 节与
  [ART-LICENSE.md](ART-LICENSE.md) 第 5 节（待核实事项）。

## 6. 仍未解决 / 待核实事项（本文件不删除、不下确定性结论）

1. DSH 的 `LICENSE.details` 及其 “No Commercial Secondary Development” 附加条款：**原文未取得**（公开仓库根目录无此文件、本机 `app.asar` 不可读），其对「独立发布插件」的适用范围**待确认**。
2. NVIDIA 是否就「通过 NVIDIA API Trial 生成的 Generated Content 的公开再分发」给出书面许可：目前按 §4.2 记录为**受限**，未取得授权。
3. `@deepseek-ai/cordis` 与 `react` 目前按 DSH 官方第三方声明记录为 MIT；如未来随发布物打包，需另行核引各自上游仓库的 `LICENSE` 原文与锁定版本。
4. 素材的完整授权链（生成模型 + 生成服务两层）以及作者是否有权授予再分发：见 [ART-LICENSE.md](ART-LICENSE.md) 第 5 节。
5. FLUX \[dev\] 许可的版本与日期需随上游更新复核（本轮记录：v2.0，Last Revised 2025-11-25）。
6. 若未来随发布物打包 Node 运行时或 `js-yaml`，需重新评估其附带的第三方组件许可（OpenSSL / ICU / V8 等）。
