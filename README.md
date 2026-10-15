# dsh-pet-guardian-dragon

DSH Web UI 桌宠 —— 形态 A「**少女主体 + 守护龙影**」。

右下角悬浮（可拖拽）与标题栏常驻**双模式，右键即切**。零构建、零依赖、不碰 DSH 核心。

本项目是**个人学习、作品展示与开源交流**项目，**不以盈利为目的**；代码与美术素材**分开授权**，
且美术素材**不是**可自由复用的资源（详见文末「许可」）。

---

## 它做什么

| # | 动作 | 实现 |
|---|---|---|
| 1 | **待机循环** | 呼吸缩放（`dg-breathe`，3.4s）。**整体摇晃 `dg-sway` 与整体浮动 `dg-float` 均已移除**，待机不再左右摆动、也不再整体上下平移 |
| 2 | **拖拽反应** | 按住拖动改变位置；按**累计横向位移驱动四帧步态循环**（walk-1 → walk-2 → walk-3 → walk-4），步幅 32px、帧间交叉淡化 0.1s；松手后按速度惯性收步（1–2 帧）再回待机。拖拽中**不做** `rotate` 倾斜 |
| 3 | **点击互动** | 位移 < 6px 判定为点击 → 切到「回眸」**专属立绘**，同时保留翻面+提亮（`dg-lookback`）变换 |
| 4 | **投喂反馈** | 双击宠物 / 右键「投喂爱心」/ 点击标题栏头像 → 切到「投喂」**专属立绘** + 爱心粒子上升 + 紫光爆闪，好感度 +2 |
| 5 | **成长进阶** | 好感度分 3 档（Lv1 / Lv2 ≥10 / Lv3 ≥30）：Lv2 起紫炎光环脉动，Lv3 起光环加强并出现上浮火星（属特效层，按约定保留 CSS） |

**回眸 / 投喂 / 走路四帧**的专属立绘由 `art/gen-actions.py` 生成，详见下文「动作立绘变体」。

状态还会**跟着会话实时变化**：会话运行中浮动与摆动明显加速；一轮结束自动播放庆祝并 +1 好感度。

好感度、投喂次数、位置、尺寸、模式全部持久化在 `localStorage`。

## 交互速查

| 操作 | 效果 |
|---|---|
| 拖动 | 移动位置并播放**四帧步态循环**；松手后按速度惯性收步再回待机（位置在松手时才保存） |
| 单击 | 回眸 |
| 双击 | 投喂爱心 |
| 右键 | 在点击处弹出菜单：投喂 / 切换悬浮↔标题栏 / 显隐 / **放大尺寸** / **缩小尺寸** / 归位 / 重置好感度 |
| 关菜单 | 点菜单外的任意位置、按 `Esc`、或选中任一菜单项 |
| 悬停 | 显示好感度 HUD |

## 文件结构

```
dsh-pet-guardian-dragon/
├── LICENSE                 # 代码许可（MIT，仅覆盖代码）
├── ART-LICENSE.md          # 美术素材许可（非商业；再分发授权待核实）
├── THIRD-PARTY.md          # 第三方组件 / 生成模型 / 服务的许可与来源说明
├── package.json            # dsh.client 声明：platform:'web' + inject（bundle.patch 已刻意移除，见下）
├── cordis.patch.yml        # profile 层：一条 insert 行
├── lib/
│   ├── index.js            # 宿主半边（纯客户端插件，apply 有意留空）
│   └── client.js           # 浏览器半边（生成物，勿手改）
├── src/
│   └── client.template.js  # 浏览器半边源码（手写）
└── art/
    ├── gen.py            # NVIDIA FLUX.1-dev 生图客户端（纯标准库 + 全黑守卫）
    ├── gen-actions.py    # 动作立绘变体（每动作一次独立调用；复用 gen.py 的密钥与全黑守卫）
    ├── cutout.py         # 绿幕抠图（阈值自动标定 + 去绿溢 + 补孔洞）
    ├── build-art.py      # 贴 512 方画布 → webp；优先用 art/src/ 外部生图
    ├── build-client.py   # 注入美术 + 套官方 lazy-CJS 外壳 → lib/client.js（node 自动探测，可用 --node 指定）
    ├── check-patch.cjs   # 校验 cordis.patch.yml（自动定位 profile，可用 --patch/--yaml/--profile 覆盖）
    ├── smoke-test.cjs    # 无头冒烟测试（迷你 React，159 项断言，含交互与立绘切换）
    ├── inspect_image.py  # 图片体检（**刻意不叫 inspect.py**，见下）
    ├── grep-asar.cjs     # 在 app.asar 里搜字符串并打印上下文（查 slot 声明用，可用 --asar 覆盖）
    ├── src/              # 外部生图产物（透明底 PNG 放这里）
    └── out/              # 素材产物（webp + png 预览）
```

> **命名教训**：这个目录里原来有个 `inspect.py`，与 Python 标准库的 `inspect` 重名。
> 运行 `python art/<任意脚本>.py` 时脚本目录会进入 `sys.path[0]`，于是 numpy 内部的
> `import inspect` 加载到了它；而它没有 `__main__` 守卫，导入即执行，随后 numpy 因拿不到
> `inspect.cleandoc` 崩溃，报错位置完全指不到真正原因。现已改名 `inspect_image.py`。
> 工具脚本不要用标准库模块名，并一律加 `__main__` 守卫。

## 重新构建

```sh
# 1) 素材：优先用 art/src/ 下的外部生图；三张齐了就不需要参考图
python art/build-art.py            # 有参考图时也可传路径作为兜底
#    动作变体（可选，需要出网提权）
#    python art/gen-actions.py --method auto --seed 7

# 2) 客户端 bundle
python art/build-client.py     # 会跑 node --check 自校验（node 自动探测，找不到可用 --node 指定）

# 3) 语法自检
node --check lib/index.js && node --check lib/client.js

# 4) 无头冒烟测试（接线 / 渲染 / 分档 / 交互 / 立绘切换 / CSS 一致性）
node art/smoke-test.cjs

# 5) 配置层可解析性
node art/check-patch.cjs
```

### 工具脚本的路径解析（不再硬编码个人目录）

三个工具脚本的路径一律按 **命令行参数 > 环境变量 > 自动探测** 解析，原有「不带参数直接跑」的用法保持不变：

| 脚本 | 命令行参数 | 环境变量 | 自动探测 |
|---|---|---|---|
| `art/build-client.py` | `--node <node 可执行文件>` | `DSH_NODE` / `DSH_DESKTOP_NODE` / `NODE_BIN` | `PATH` 里的 `node`、DSH Desktop 自带 node（`%APPDATA%\dsh-desktop\harness\.desktop-bin` 等） |
| `art/check-patch.cjs` | `--patch` / `--yaml` / `--profile` | `DSH_PATCH_FILE` / `DSH_JS_YAML` / `DSH_PROFILE_DIR`（或 `DSH_WEB_PROFILE`） | `%APPDATA%\dsh-desktop\harness\profiles\web`，并逐级 `require.resolve('js-yaml')` |
| `art/grep-asar.cjs` | `--asar <app.asar>` | `DSH_ASAR` | `%LOCALAPPDATA%\Programs\DSH Desktop\resources\app.asar`、`%ProgramFiles%\DSH Desktop\...` |

找不到路径时脚本会打印**尝试过的全部位置**并以退出码 `2` 失败，不会静默跳过。
唯一的例外是 `build-client.py` 的 `node`：它只用于产物语法自检，找不到时会退化为括号配对粗检并明确提示。

## 生图与抠图（NVIDIA FLUX.1-dev）

美术已从「参考图裁切」升级为**真生图 + 真抠图**。三个素材各自独立生成，因此天然可分层。

### 为什么是「绿幕 + 抠图」而不是直接出透明图

实测该模型**只返回 JPEG**（无 alpha 通道），`width/height` 也只接受 768…1344 的固定档位。
所以透明底必须走「纯色幕布 + 后期抠图」。选择绿色是因为形态 A 的配色（银发 / 白紫裙 /
粉花 / 黑镰刀 / 紫眼）**完全不含绿**，色度上可干净分离。

### 实测确认的接口契约

| 项 | 值 |
|---|---|
| 端点 | `POST https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev` |
| 鉴权 | `Authorization: Bearer <NVIDIA_API_KEY>`（`nvapi-` 开头） |
| 必填 | `prompt` |
| 尺寸 | `width`/`height` ∈ {768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344} |
| 步数 | `steps ≥ 5` |
| 禁用 | `aspect_ratio` 等额外字段会 422 `extra_forbidden` |
| 响应 | `{"artifacts":[{"base64":"<JPEG>"}]}` |
| 速度 | 896×1216 / 28 步约 **12 秒** |

同账号下 `stabilityai/*` 系列返回 `Function … Not found for account`（未开通），
**FLUX.1-dev 与 flux.1-kontext-dev 可用**。

### 两个必须知道的坑

1. **静默全黑输出**。某些提示词下接口会返回 HTTP 200、JSON 合法、但内容是**纯黑图**
   （1024×1024、约 6.3 KB、最亮像素 0），且耗时明显更短（2.5–6 s vs 正常的 9–12 s）。
   实测 8 次里，含 `violet` 措辞的 4 次**全部**触发，不含的 4 次全部正常
   （`purple` 不受影响）。`art/gen.py` 已加**全黑守卫**：检测到就报错并**拒绝写出文件**，
   避免把黑图当成素材（可用 `--allow-blank` 强制）。
2. **抠图阈值必须自动标定**。不同提示词/种子出来的幕布绿色深浅差别很大——实测少女图边缘
   绿优势度 67、头像 88，而龙首只有 37。写死阈值会让浅绿幕布的背景被判成半透明
   （bbox 收不紧、边缘留一层绿雾）。`art/cutout.py` 现在从**画面边缘环带的中位数**自动推导
   `lo/hi`，并会提示「几乎检测不到绿幕」。

### 工作流

```sh
# 1) 生成（需要出网；见下方「沙箱注意事项」）
python art/gen.py --preset girl  --seed 7  --out art/out/gen/girl-raw.jpg
python art/gen.py --preset dragon          --out art/out/gen/dragon-raw.jpg
python art/gen.py --preset avatar --seed 21 --out art/out/gen/avatar-raw.jpg

# 2) 绿幕抠图（自动标定阈值；--check 会输出品红底叠加预览便于目视验收）
python art/cutout.py art/out/gen/girl-raw.jpg art/src/girl.png --check art/out/gen/girl-check.png

# 3) 统一贴到 512 方画布（不需要参考图）
python art/build-art.py
python art/build-client.py
```

`art/gen.py` 内置三套提示词（`girl` / `dragon` / `avatar`）。**头像提示词必须强锚定
「2D / 赛璐璐 / 非 3D」**，否则模型会飘到 3D 写实风，和全身立绘不是同一个角色（实测踩过）。

## 动作立绘变体（`art/gen-actions.py`）

「回眸」「投喂反应」以及**走路四帧**（walk-1 … walk-4）各自使用专属立绘，不再只是同一张图加 CSS 变换。
拖拽已由「按鼠标横向速度 `rotate` 倾斜」改为「四帧步态循环」，细节见下。

产物：`art/src/girl-lookback.png`、`girl-feed.png`、`girl-walk-1.png` … `girl-walk-4.png`。
（`girl-lean.png` 仍会生成，但客户端已不引用，保留以便回退。）

```sh
# 生成动作变体（先试图生图 → 按实切换文生图 → 自动走 cutout.py 抠图）
# 默认生成客户端实际使用的六张：lookback / feed / walk-1 .. walk-4
python art/gen-actions.py --method auto --seed 7
python art/build-art.py          # 贴 512 方画布（会打印每个产物的来源）
python art/build-client.py
```

### 走路四帧（walk-1 … walk-4）

四帧由**同一模板**拼接，只替换左右腿描述与重心高度：contact（触地）与 passing（过腿）
各出 A / B 两帧，B 帧 = A 帧的 left/right 对调。

```python
WALK_PROMPT = ("Anime character in a walk cycle {pose} pose, {legs}, {arms}, "
               "torso at its {torso} point, body upright and facing forward. "
               "Her black-purple scythe ... stays resting on her right shoulder ... "
               "Wearing a white and purple off-shoulder gown ... Plain green background.")
WALK_POSES = {
    "A": {"pose": "contact", "legs": "left leg stepping clearly forward, right leg "
          "stretched clearly behind, a wide readable stride", "torso": "lowest",  "seed": 401},
    "B": {"pose": "passing", "legs": "right knee lifted clearly in front with the foot "
          "well off the ground, left leg straight and vertical", "torso": "highest", "seed": 402},
}
```

`assert_walk_frames_consistent()` 在每次运行时自检：把各自的腿描述替换成占位符后，
两段提示词必须**完全相同**，否则直接报错退出。这样「只改左右腿」这条约束由代码保证，
而不是靠人工核对。

#### 两个必须钉住的地方（都踩过）

纯文生图没有参考图，模型会**逐帧重新决定**提示词没写到的细节，于是出现两类逐帧闪烁：

| 现象 | 根因 | 修法 |
|---|---|---|
| 镰刀在「扛肩」与「竖抱身前」之间跳变 | 提示词完全没提镰刀，而 `arms` 槽位让手臂自由摆动 | 加 `scythe ... stays resting on her right shoulder ... do not move or shift the scythe`，并把 `arms` 槽位改成「右手扶着肩上的镰刀」 |
| 整身服装漂成紫色长外套 | 我加的 `bare feet` 与设定表的 `white stockings` **直接矛盾**，服装线索自相冲突 | 删掉矛盾项，把服装描述**逐字复述并置于句末**（扩散模型对末尾 token 权重更高） |

另外步幅描述不能太保守：早先写「left heel striking the ground in front」时，左右对调后
两帧看起来几乎一样，走路节奏根本读不出来。现在写成「clearly forward / stretched clearly
behind / knee lifted clearly with the foot well off the ground」，配合 `STRIDE_PX = 32`
才有可辨的踏步感。

### 关键发现 1：kontext 图生图在本账号上不可用

任务原本指定用 `flux.1-kontext-dev` 做图生图。**实测该端点只接受服务端预注册的
`example_id`，不接受任意图片字节**，因此无法拿我们自己的立绘作输入：

| 请求 | 结果 |
|---|---|
| `image` = 裸 base64 | 422 `Image has been provided in the invalid form` |
| `image` = `data:image/jpeg;base64,<真实图>` | 422 **`Expected: example_id, got: base64`** |
| `image` = `data:image/jpeg;example_id,0` / `,1` | 200，但输出是**纯黑图**（mean=0、max=0、6.5 KB） |
| `image` = `data:image/jpeg;example_id,自定义值` | 500（查不到该示例） |
| `flux.1-dev` + `image` | 422 `Image input is not supported in the base mode` |
| `flux.1-dev` `mode=canny/depth` + 图片 | 同样报 `Expected: example_id, got: base64` |
| 另外 12 个图片编辑模型名 | 404 模型不存在 |

`flux.1-dev` 的 `mode` 枚举经报错确认为 `'base'` / `'canny'` / `'depth'`，图片输入只在
canny/depth（控制图）下被接受，且同样只认 `example_id`。**该账号没有可用的图生图能力。**

因此 `gen-actions.py` 的 `--method auto` 会先如实尝试指定路径、打印确切拒绝原因，
再切换到 `flux.1-dev` 文生图；`--method img2img` 可强制只走原路径（会如实失败）。

### 关键发现 2：`violet` 会触发静默全黑

同 seed、同尺寸步数，**仅一处措辞差异**：

| 提示词 | 结果 |
|---|---|
| `...violet eyes...` | **静默全黑**：HTTP 200、最亮像素 0、6.5 KB、4.0s |
| `...purple eyes...` | 正常：118.9 KB、最亮像素 255、8.0s |

任务给的动作提示词里含 `violet eyes`，正是触发词。`gen-actions.py` 因此**保留动作原文**、
只在构建提示词时做等价替换（`violet` → `purple`）并在日志里说明改了什么。

### 关键发现 3：锁 seeds 是文生图下抑制身份漂移的最强杠杆

文生图没有参考图，角色设计由基础噪声极大决定。用每个动作各自的 seed（101/202/303）时，
**发型与服装设计明显漂移**；改用原始立绘的 **`seed=7`** 后，四张图明显是同一个角色
（发色/瞳色/精灵耳/皇冠+蓝花/白紫裙配粉色花边/同一把镰刀/同样的袜纹一致），
差异只在姿态与表情。所以默认建议 `--seed 7`。

### 客户端如何切换

`POSE_SRC` 把**非走路**状态映射到立绘：`idle / lookback / feed / lean`，**任一图缺失都回退到
待机立绘**，不会出现空白。走路四帧单独走 `WALK_FRAMES`（顺序 `[walk-1, walk-2, walk-3, walk-4]`，
同样逐张回退到待机）。

渲染优先级：**走路激活时 → 走路帧；否则 → 当前姿态帧**。走路帧用独立状态 `walkState`
（而非复用 `pose`），这样 `lookback`/`feed` 的定时回落不会在拖拽中途把帧改回待机。

步态驱动（常量集中在模板顶部）：

| 常量 | 值 | 作用 |
|---|---|---|
| `STRIDE_PX` | 32 | 步幅。相位 = 累计横向位移 ÷ 32，帧号 = `floor(相位) % 4` |
| `FRAME_LIFT_PX` | `[0, -2, 0, -2]` | 四帧各自的纵向偏移，模拟重心起伏 |
| `SETTLE_STEP_MS` | 95 | 收步时每帧停留时长 |
| `SETTLE_FAST_PX` | 12 | 松手速度 ≥ 12 收 2 帧；> 0 收 1 帧；静止则立即回待机 |

- `pointerdown` → 进入走路、从当前帧起步；纯点击（位移 < 6px）不计步
- `pointermove` → 按累计位移推进/回退帧号；**左右朝向由外层 `scaleX(±1)` 承担**
  （四帧本身都面朝前，镜像即可表示向左/向右走），该变换刻意放在不带 transition 的外层，
  以免跨零翻转时被插值成一条缝
- `pointerup` → 按松手速度进入**异步收步链**（`setTimeout` 逐帧推进，走完才回待机）；
  位置**只在此时**落盘

帧切换的视觉处理：`.dg-walk-lift` 承担 `translateY(FRAME_LIFT_PX[i])`（0.1s ease-out），
新帧以 `.dg-walk-fade` 叠在旧帧上做 0.1s 交叉淡化，避免硬切闪帧。

其余切换与既有 CSS 特效同一时机：

- 点击（位移 < 6px）→ 换「回眸」立绘，同时保留原有的翻面+提亮 CSS 变换
- 投喂 / 一轮结束 → 换「投喂」立绘，同时保留原有的发光与爱心粒子

按任务约定，**待机微动与成长进阶仍走 CSS**（微动幅度无法用文字传达；光环/火星属特效层），
而拖拽不再做 `rotate` 倾斜；整块 `dg-sway` 整体摇晃与 `dg-float` 整体浮动均已移除。

### 密钥存放

按优先级读取：`--key-file` > 环境变量 `NVIDIA_API_KEY` > **`<工作区根>/.nvidia-key`**。
密钥刻意放在**工作区根目录而不是插件目录内**，这样交付物里不含任何凭据。
（注意：密钥曾在对话里以明文出现过，介意的话建议在控制台轮换一次。）

### 沙箱注意事项（重要）

**任何子进程的出网 HTTPS 都需要提权（`danger-full-access`）**，否则 TLS 握手一律失败：

| 调用方 | 报错 |
|---|---|
| `curl.exe` | `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)` |
| PowerShell `Invoke-WebRequest` | `基础连接已经关闭: 接收时发生错误`（内层同为 SEC_E_NO_CREDENTIALS） |
| Python `urllib` | `SSL: UNEXPECTED_EOF_WHILE_READING` |

但 **DNS 解析与 TCP 443 连接都正常**（`Test-NetConnection` 成功、裸 `TcpClient` 能连上），
所以这不是网络问题，而是**沙箱阻止了进程获取 TLS 客户端凭证**。注意 Python 用的是内置
OpenSSL 而非 Windows Schannel，同样被拦 —— 说明限制在更底层。提权后 curl 与 Python 均
正常（HTTP 200、模型列表 80 个）。

排查中排除掉的两条歧路，避免重复踩：**TLS 版本**（显式设置 `SecurityProtocol` 到
Tls12/Tls13 无效）与**本机 HTTP 代理**（IE 系统代理开着，但绕过代理直连同样失败）。

## 接入任意生图模型（不需要改代码）

美术管线与具体生图模型**完全解耦**。把模型产出的图按固定文件名放进 `art/src/`，`build-art.py` 会自动优先使用：

| 文件 | 内容 | 建议 |
|---|---|---|
| `art/src/girl.png` | 少女主体 | **透明底**全身立绘 |
| `art/src/dragon.png` | 守护龙影 | 透明底 |
| `art/src/avatar.png` | 标题栏头像 | 方形、透明底 |

判定规则：

- 存在且**确实含透明像素** → 视为真抠图，直接使用，**不加任何遮罩**（理想路径，发丝/裙摆/龙影都能保住）
- 存在但**不含透明通道** → 退回软边圆角遮罩并打印提示，避免出现硬边矩形
- 不存在 → 用参考图裁切结果兜底

三张齐了之后**参考图可以完全不传**：

```sh
python art/build-art.py        # 不需要任何参数
python art/build-client.py
```

支持 `.png` / `.webp` / `.jpg`（alpha 只可能存在于前两者）。每个产物都会打印来源，便于确认到底用了哪一张：

```
girl   : girl.webp  512x512  34.0 KB   <- art/src/girl.png（外部生图·含透明通道）
```

所以换模型时只需替换 `art/src/` 下的图并重跑两条命令，**零代码改动**。

## 安装

```sh
# 1) 拷进 profile 的 node_modules
$H = "$env:APPDATA\dsh-desktop\harness"
$P = "$H\profiles\web"
Copy-Item -Recurse -Force . "$P\node_modules\dsh-pet-guardian-dragon"

# 2) 在 $P\cordis.patch.yml 末尾追加
#    - insert:
#        - id: dsh-pet-guardian-dragon
#          name: 'dsh-pet-guardian-dragon'
```

配置层支持热重载；改完**硬刷新浏览器**（Ctrl/Cmd+Shift+R）。客户端产物缺失或语法错误会让 `dsh web` 拒绝启动，所以务必先跑 `node --check`。

回滚：删掉 `node_modules\dsh-pet-guardian-dragon` 并移除 patch 里的 insert 行。

## 为什么是手写 bundle 而不是打包

开发环境里 `git` / `npm` 不可用，`pnpm` 又因受限环境禁止子进程命名管道而 `spawn EPERM`，因此无法克隆仓库或安装依赖。而官方的 `clientBundle` 预设位于 DeepSeek Harness 仓库的 `packages/client/tsdown.client.ts`，**不在任何已发布包里**，仓库外本来就无法复刻。

于是直接照抄官方预设的产物形状手写：

```js
window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/* bundle body */
return module.exports; } });
```

对应 `packages/client/tsdown.client.ts` 的 `outputOptions.banner` / `intro` / `footer`。可 `require` 的平台模块表见 `packages/client/web/src/platform.ts`（`react`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots` 等）。

## 挂载点（已在运行中的 DSH 上实测确认，非推测）

| 模式 | slot | 声明方 | cardinality / scope |
|---|---|---|---|
| 右下角悬浮 | `shell.overlay` | `@deepseek-ai/dsh-client-ui-layout` | `kind: "list"` / `scope: "root"` |
| 标题栏常驻 | `conversation.session.header.actions` | `@deepseek-ai/dsh-client-ui-conversation` | `list` / `session` |

`shell.overlay` 的声明是从运行中的 `ui-layout` client bundle 里直接读出来的：

```js
ctx.slots.register({ name: "root", children: {
  "sidebar":       { kind: "single", scope: "root" },
  "main":          { kind: "keyed",  scope: "root" },
  "rightbar":      { kind: "single", scope: "root" },
  "shell.overlay": { kind: "list",   scope: "root" },   // ← 本插件挂这里
  "shell.leading": { kind: "single", scope: "root" },
} }, AppFrame)
```

因为它是 **list**（以必填 `id` 定址、按 `order` 排序），追加成员不会与既有 occupant（`shell.quota-notice`）冲突。

## 状态来源

`@deepseek-ai/dsh-client-ui-session` 通过 `ctx.slots.provideRoot` 注入标准 props：

```js
hooks: { sessions: ctx.sessions.list, sessionStatus: service.sessionStatus }
```

对应组件 props 为 `useSessions` / `useSessionStatus`，其中 **`sessionStatus` 是 `Map<sessionId, {running}>`**。文档说明这两个 hook 在**所有 scope** 可用，因此 `root` 作用域的 `shell.overlay` 也能直接拿到运行状态——**不需要标题栏、不需要 IPC、不需要 MCP**，而且没有打开会话时也能反映其它会话的运行情况。

## 已验证的运行时事实

| 验证项 | 结果 |
|---|---|
| 插件是否进入启动图 | ✅ `window.__DSH_BOOT__.entries` 含 `dsh-pet-guardian-dragon` |
| 是否需要重启 DSH | ✅ 不需要，patch 层热重载即生效 |
| bundle 是否被真正提供 | ✅ `GET /plugins/??dsh-pet-guardian-dragon/client.js&rev=…` → 200 |
| 宿主是否感知产物更新 | ✅ rev 随产物变化：`9a54… → 579c… → de75… → 15488a3dbad9` |
| 代码能否真的正确执行 | ✅ 无头冒烟测试 159 项断言全通过（PASS=159 FAIL=0），含 5 个动作、右键菜单、四帧步态相位、收步链、尺寸步进 |
| `shell.overlay` 是否可安全使用 | ✅ 从运行中的 `ui-layout` 读到 `{kind:"list", scope:"root"}` |
| 悬浮层是否会被裁剪/错位 | ✅ 抽 CSS 逐项排除（见上节） |
| 配置层是否仍可解析 | ✅ 用 harness 自带的 `js-yaml` 解析通过，原有条目完好 |
| 产物语法 | ✅ `node --check` 通过，纯 ASCII |
| 是否弄坏宿主 UI | ✅ 日志里**没有**本插件的任何错误/告警/畸形声明 |

## 悬浮层几何：为什么 `position:fixed` 是安全的

`shell.overlay` 渲染进 `ui-layout` 的这个容器（CSS 已从运行中的 bundle 里抽出）：

```css
.pI_x6G_overlayLayer { position:absolute; inset:0; z-index:20; pointer-events:none }
.pI_x6G_overlayLayer > * { pointer-events:auto }
.pI_x6G_frame { position:relative; overflow:hidden; display:grid; height:100% }
```

排查结论（逐项实测，非推测）：

| 风险 | 结论 |
|---|---|
| 祖先有 `transform` / `filter` / `perspective` / `will-change` / `contain` / `backdrop-filter` / `isolation` → `fixed` 会改以该祖先为包含块 | ✅ **全部不存在**，因此 `fixed` 相对视口解析 |
| `frame` 的 `overflow:hidden` 会裁剪宠物 | ✅ 不会。裁剪只作用于**包含块链上的**祖先；`fixed` 的包含块是视口，故不受影响 |
| 宠物挡住它后面的 UI | ✅ 已处理：外层 `pointer-events:none`，本插件 `.dg-root{pointer-events:none}` + `.dg-stage{pointer-events:auto}`，只有宠物本体可点 |
| 与既有 occupant 抢位 | ✅ 该槽是 `kind:"list"`，以必填 `id` 定址，不冲突 |

## 无头冒烟测试

冒烟测试不依赖浏览器，也不需要解包 `app.asar` 去 require 里面的 React，因此 `art/smoke-test.cjs` 自带一个**确定性迷你 React**，把 `lib/client.js` 里真实的 factory 物化、真实的 `apply` 执行、真实的组件渲染一遍。

```sh
node art/smoke-test.cjs     # 当前 159 项断言全部通过（PASS=159 FAIL=0）
```

覆盖内容：

- 产物**只**请求平台模块（`require` 白名单里只有 `react`，请求别的立即失败）
- `apply` 往 `shell.overlay` 与 `conversation.session.header.actions` 注册，`id`/`order`/`name` 正确
- 渲染结构：`.dg-root` / `.dg-stage` / `.dg-dragon` / 内联美术 ×2 / 3 颗火星 / HUD / 拖拽与点击右键钩子
- 成长分档：好感度 0 → `data-tier=1`、12 → `2`、35 → `3`，文案同步
- 模式切换：float 时 overlay 可见、chip 隐藏；header 时相反
- 状态选择器：对 `Map`（全跑/全停/混合）、`Array`、普通对象、`undefined`、`42` 都给出正确布尔值
- CSS 一致性：渲染出的类名全部有对应规则；8 个关键帧齐全；`.dg-root` 为 `fixed`；三档成长都有视觉差异；
  并断言 **`@keyframes dg-sway` 已移除**、无 `.dg-sway` 规则、**无 `.dg-drag` 动画覆盖规则**（待机不摇晃 / 拖拽不改周期）
- 降级路径：缺 `useSessionStatus`（老版本 DSH）仍能渲染；缺 `ctx.slots` 时安全返回
- **交互行为（用例 G，真正调用事件处理器）**：
  - 拖拽：位置改变、**按下即切入走路帧**、**累计位移每满 32px 推进一帧**、**走满四帧回到第一帧**、
    **不足一个步幅不换帧**、**来回拖按绝对位移累计**、**方向翻转体现为 `scaleX(±1)`**、
    **松手不瞬回待机（进入按速度决定的收步链）**、**只在松手时落盘**（`pointermove` 不写 localStorage）、
    `.dg-drag` 增删、**拖拽中不再写 `rotate`**
  - 点击：位移 < 6px 判定为点击 → 回眸 class，且不改位置
  - 投喂：双击 → 投喂 +1、好感度 +2、发光 class、**生成 6 颗爱心粒子**
  - 成长：好感度 9 → tier1；投喂后 11 → **重新渲染确认真进阶到 tier2 且显示 Lv2**
  - 会话状态：空闲不加运行态 class；运行中加 `dg-thinking`/`dg-working`；**一轮结束播放庆祝、好感度 +1、回合数 +1**
- **右键菜单（用例 H，回归测试）**：
  - 菜单是 `.dg-root` 的直接子元素、**不是 `.dg-stage` 的后代**（这条直接钉住曾经的 bug）
  - 出现在右键点击处，并夹在视口内
  - 按钮点击真的生效（切模式 → `state().mode === 'header'`）
  - 点菜单外关闭、按 `Esc` 关闭、选中项后关闭
  - 菜单**内部**按下不关闭（否则按钮的 `click` 会失去目标）

> **曾经的真实 bug（已修）**：菜单原先是 `.dg-stage` 的子元素，而 `.dg-stage` 的
> `onPointerDown` 会 `setPointerCapture()`（把后续指针事件重定向到 stage）并
> `preventDefault()`（抑制兼容性鼠标事件），于是菜单按钮的 `click` 永不触发；
> 而菜单唯一的关闭途径就是那些按钮，结果**点不动也关不掉**。修法是把菜单移出
> `.dg-stage` 并补上外部点击 / `Esc` 关闭。注意「按钮有没有 onClick」在旧代码上
> 也是通过的——这类 bug 只有结构断言与关闭行为断言才抓得到。

- **尺寸放大 / 缩小（用例 J，回归测试）**：
  - 原先只有一个**循环**按钮（120→160→200→240→280→跳回 120），尺寸只能一路变大，
    绕回小尺寸之前**无法往回缩**。现拆成「放大尺寸」「缩小尺寸」两个显式项，
    并钳制在 `SIZE_MIN=120` / `SIZE_MAX=280`（步长 40）
  - 断言：默认 160 时「缩小」可用且点一次变 120；到下限后该项**禁用**且强制点击不越界；
    连点四次「放大」到上限 280；到上限后「放大」**禁用**且**不跳回小尺寸**（旧行为正是跳回 120）；
    再连点四次「缩小」回到 120

- **立绘切换（用例 I）**：
  - 待机立绘非空，且七张立绘全部是内联 `data:` URI（不依赖任何外部请求）
  - 拖拽开始即切到走路帧；**位移未达一个步幅时保持同一帧**（不会抖动式乱切）
  - 累计 32px → 推进到第二帧；**四帧依次推进且互不相同**；**走满四帧回到第一帧**（步态循环）
  - 拖拽中不再写 `rotate`；松手不瞬回待机（进入收步）
  - 轻点 → 切到「回眸」帧，且**收步链不会把动作立绘顶掉**；投喂 → 切到「投喂」帧
  - **待机 + 走路四帧 + 回眸 + 投喂共七张两两不同** —— 专门防止某张缺失时静默回退成同一张却看不出来

- **收步链（用例 K）**：
  - 松手时仍在运动 → **不瞬回待机**，收步期间帧序号单调前进，走完才回待机且淡出层被移除
  - 松手瞬间完全静止 → **立即**回待机（不进入收步）
  - 收步未走完就重新按下 → **旧收步链被掐断**，帧停在新按下的位置（防止两条链互相打架）

为了让行为可测，测试里的迷你 React 实现了几处保真细节：**hook 状态按组件类型跨渲染复用**
（否则 `useRef` 每次新建，「上一轮是否在运行」这类跨渲染逻辑根本测不到）、**DOM 节点按树中路径跨渲染复用**
（真实 React 会复用节点，命令式 `classList.add('dg-drag')` 才能在重渲染后保留；早先每轮新建节点会让这类改动凭空消失，
既造成假失败也会掩盖真实 bug）、**提交后冲刷 effect 并先执行上一轮清理**、以及带 `classList` /
`style.setProperty` / `ref` 的假 DOM。

## 已知限制（诚实清单）

1. **美术是真生图 + 真抠图，但仍非「分部件骨骼动画」**。现在是 NVIDIA FLUX.1-dev 生成、绿幕抠出的独立透明素材（少女主体 / 守护龙影 / 头像 256 / 回眸 / 投喂 / 走路四帧），龙影作为独立元素浮游并参与点击回眸与投喂特效。但每张素材是整图而非分层（发丝/裙摆没有单独图层），因此**走路是用四帧整图按相位循环**模拟踏步，而不是骨骼驱动的连续步态；发丝与裙摆也没有独立运动。
2. **动作变体是文生图产物，不是真正的图生图**。任务原本指定 kontext 图生图，但该端点在本账号上只接受预注册的 `example_id`（完整实测见上文），所以所有变体都是用**锁定的角色设定表 + 原始种子 seed=7** 独立生成的。各帧在发色/瞳色/精灵耳/皇冠+蓝花/裙装配色/镰刀上一致，但**并非像素级同一角色**：皇冠尖角形状、裙摆纹样细节、鞋子等仍有小幅差异；走路四帧之间也存在这类差异。更麻烦的是**模型会逐帧重新决定提示词没写到的细节**——镰刀怎么拿、穿不穿鞋——所以姿态提示词必须显式钉住道具与服装（见上文「两个必须钉住的地方」）。若日后该账号开通了真正的图生图能力，把 `gen-actions.py --method img2img` 接上即可，脚本与后续管线都不用改。
3. **走路是四帧相位驱动，不是逐帧动画**。contact-A / passing-A / contact-B / passing-B 四个关键帧按累计横向位移循环，帧间靠 0.1s 交叉淡化与 2px 纵向起伏过渡。再提高流畅度就要为更多相位生成独立立绘，成本线性增长，且每多一帧都会推高内联体积（当前四帧合计约 116 KB）。
4. **思考与干活未区分**。两者都由「有会话 running」驱动，只是动画速度不同。要区分需要读推理 partial / 运行中工具（`useConversation` 的 `views.get('chat').legacy`），但该 hook 只在 `session` 作用域可用，悬浮层的 root 作用域拿不到，需要额外设计。
5. **未做 Live2D**。当前是静态图 + CSS 变换。要真 Live2D 需引入 `pixi-live2d-display` 与 Cubism Core，并注意模型与 Cubism 的商用授权条件。
6. **未在真实浏览器里目视确认**。启动图与资源提供都已验证，但「桌宠画出来、拖得动、特效正确」需要你在浏览器里目视确认。代码已包在 React 错误边界里：万一某个 DSH 版本的 slot 契约变化导致渲染抛错，只让桌宠消失，不会连累 AppFrame。
7. **`dsh.client.inject` 的改动要重启才生效**。启动图里当前仍是最初声明的三个 inject 边（宿主对包元数据有缓存）。实测这三个包都存在且组合成功，所以留着也无害；下次重启后会变成空列表。
8. **走的是 patch 层挂载，未进 profile 清单**。DSH Desktop 有一项 profile 一致性审计，它看的是 `profiles/web/package.json`（`dependencies` / `dsh.profile.bundles`），**不认 patch 层**。所以它可能记一条 `profile inconsistency: … is installed but declared nowhere in the profile manifest`。实测这不影响加载（本插件确实进了启动图并被正常提供），当前日志里也**没有**本插件的此类记录。若想彻底消除，等 pnpm 可用时执行 `dsh plugin --profile web add link:<本目录绝对路径>` 即可（受限环境下禁止子进程命名管道，pnpm 会报 `spawn EPERM`，因此这一步无法在受限环境中完成）。

## 许可

本项目是**个人学习、作品展示与开源交流**项目，**不以盈利为目的**，采用**代码与美术分离**的授权结构，
两者不共用同一许可：

| 内容 | 许可 | 文件 |
|---|---|---|
| 代码（`lib/index.js`、`src/client.template.js`、`art/*.py`、`art/*.cjs`、配置与文档） | MIT | [LICENSE](LICENSE) |
| 美术素材（`art/src/*.png`、`art/art-data.json`，以及 `lib/client.js` 中内联的立绘数据） | 单独的素材许可：**非商业**，且**再分发尚未授予**、授权链待核实 | [ART-LICENSE.md](ART-LICENSE.md) |

- 代码版权：`Copyright (c) 2026 lucas07814`。
- **美术素材不是 MIT 许可**：代码的 MIT 许可**不会**自动扩展到素材。
- **本仓库不是可自由复用的素材库**：素材的生成模型与生成服务授权链尚未核实，在核实完成前
  **不应将素材视为已获准自由再分发**；商业使用与再分发均需**另行取得作者的书面授权**。
- 第三方组件、生成模型与生成服务的来源与许可（含仍标注「待核实」的条目）见 [THIRD-PARTY.md](THIRD-PARTY.md)，
  其条款以各上游官方原文为准；其中**模型输出许可与生成服务分发许可彼此独立**，不互相替代。
