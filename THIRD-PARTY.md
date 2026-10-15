# 第三方组件、模型与服务说明（THIRD-PARTY）

本文件记录本项目**依赖、调用或参考**的第三方内容及其许可归属。
本项目自身的许可结构：**代码 = MIT**（[LICENSE](LICENSE)），**美术素材 = 单独许可**（[ART-LICENSE.md](ART-LICENSE.md)）。

> 标注「**待核实**」的条目，表示作者尚未取得可引用的官方许可原文。此类条目只记录事实与出处，
> **不代表作者对其许可范围作出任何承诺或扩大解释**；一律以各上游项目的官方条款为准。

## 1. 运行平台：DeepSeek Harness（DSH）

| 项 | 内容 |
|---|---|
| 关系 | 本插件是 DSH Web UI 的插件，通过 slot（`shell.overlay`、`conversation.session.header.actions`）挂载；不修改 DSH 自身代码，也不随本项目分发 DSH 代码 |
| 许可 | MIT（**待核实**：许可声明由项目作者提供，尚未附上游仓库 URL 与 LICENSE 原文） |

`package.json` 中的运行时依赖只有 `peerDependencies`：`@deepseek-ai/cordis` 与 `react`。
两者**不随本项目分发**，其许可以各自上游为准。`lib/client.js` 只 `require('react')` 这一个平台模块
（由 `art/smoke-test.cjs` 的 require 白名单断言），未打包任何第三方 JavaScript 库。

## 2. 美术素材的生成模型与服务

| 项 | 内容 |
|---|---|
| 生成服务 | NVIDIA API（`https://ai.api.nvidia.com/v1/genai/...`） |
| 使用模型 | `black-forest-labs/flux.1-dev` —— 全部 10 张立绘；`black-forest-labs/flux.1-kontext-dev` —— 曾尝试图生图，最终**未采用** |
| 模型许可 | **待核实**。FLUX.1-dev 由 Black Forest Labs 发布，属于限制商业用途的一类许可；作者未取得许可原文，故本文件不引用具体许可名称与版本号 |
| 服务条款 | **待核实**。NVIDIA API 关于「生成结果可否公开再分发」的条款原文尚未核引 |
| 本项目立场 | 由此生成的立绘按 [ART-LICENSE.md](ART-LICENSE.md) **只授权非商业使用与再分发**；该授权不超出原始模型/服务条款所允许的范围 |

## 3. 构建期依赖（Python，均不随发布物分发）

| 组件 | 本项目中的用途 | 许可 | 依据 |
|---|---|---|---|
| Pillow 12.3.0 | `art/build-art.py`、`art/cutout.py`、`art/gen.py`、`art/inspect_image.py` 的图像读写、画布合成与绿幕抠图 | MIT-CMU | 已核实：`pillow-12.3.0.dist-info/METADATA` 中 `License-Expression: MIT-CMU` |
| numpy 2.3.5 | `art/cutout.py` 的阈值标定与 alpha 计算 | BSD-3-Clause | 已核实：`numpy-2.3.5.dist-info/METADATA` 中 `Classifier: License :: OSI Approved :: BSD License`，`LICENSE.txt` 为三条款 BSD 条文 |

其它 Python 依赖：**无**（`art/gen.py`、`art/gen-actions.py` 的生图请求只用标准库 `urllib`）。

## 4. 构建期工具（Node.js，不随发布物分发）

| 组件 | 用途 | 许可 |
|---|---|---|
| Node.js | 运行 `art/smoke-test.cjs`、`art/check-patch.cjs`、`art/grep-asar.cjs`，以及 `node --check` 语法校验 | MIT（**待核实**具体版本与许可原文） |

三个脚本只使用 Node 内置模块（`fs` / `path`）。其中 `art/check-patch.cjs` 额外 require
DSH 自带的 `js-yaml` 用于解析 `cordis.patch.yml` —— 该库**不随本项目分发**，为构建期临时使用，
其许可以上游为准（js-yaml 为 MIT，**待核实**）。

## 5. 素材来源声明

- 发布物中的 10 张立绘取自 `art/src/*.png`，作者确认这些文件是**文生图产物**。
  `art/build-art.py` 内保留了「参考图裁切」兜底路径，但发布物中的素材不取自该路径。
- 生成提示词只描述角色特征（发色 / 瞳色 / 精灵耳 / 皇冠与花 / 裙装配色 / 镰刀），
  经检查 `art/gen.py` 与 `art/gen-actions.py` 的提示词文本，**未包含任何既有作品名、角色名或商标**。
- 角色形象为原创设定。作者无法保证不存在与既有作品的偶然相似，亦不对此作出担保。
- 素材按「现状（as-is）」提供，不附带任何明示或默示担保。
