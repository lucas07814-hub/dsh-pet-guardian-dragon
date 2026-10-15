"""
动作立绘变体生成器 —— 每个动作独立一次调用，一轮只改一个维度

╔══════════════════════════════════════════════════════════════════════════════╗
║ 重要：kontext 图生图在本账号上不可用（已完整实测，见 --probe-note）          ║
║                                                                              ║
║ flux.1-kontext-dev 的 `image` 字段只接受**服务端预注册的 example_id**，      ║
║ 不接受任意图片字节。实测证据：                                               ║
║   * image = 裸 base64            -> 422 "Image has been provided in the       ║
║                                          invalid form"                        ║
║   * image = data URI(base64)     -> 422 "Expected: example_id, got: base64"   ║
║   * image = data URI(example_id,0|1) -> 200，但输出是**纯黑图**（mean=0,max=0）║
║   * image = data URI(example_id,自定义) -> 500（查不到该示例）                ║
║ flux.1-dev 同样不行：base 模式的 image 输入直接报                                ║
║   "Image input is not supported in the base mode"，而 canny/depth 模式下      ║
║   的 image 走同一个解析器，也只认 example_id。                                ║
║ 账号上不存在其它图片编辑模型（12 个候选模型名全部 404）。                     ║
╚══════════════════════════════════════════════════════════════════════════════╝

因此本脚本的默认行为是：
  1. 先按指定方式尝试 kontext 图生图（--method img2img 可强制只走这条）
  2. 一旦被结构性拒绝，就打印确切原因，并切换到 **flux.1-dev 文生图**
  3. 文生图时用一段**锁定的角色设定表**，三个动作共用、逐字相同；
     唯一变化的是动作子句。这是没有图生图时可用的最强身份约束手段，
     同时天然满足「不链式迭代、避免漂移累积」。

密钥读取优先级与全黑守卫**直接从 gen.py 导入**（不复制、不改动 gen.py），
从而保证与既有实现逐字一致。
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ART = Path(__file__).resolve().parent
sys.path.insert(0, str(ART))

# 照搬：密钥优先级 + 全黑守卫 + 绿幕约定 + 角色设定表，全部来自既有 gen.py
from gen import CHROMA, PRESETS, blank_peak, read_key, sniff_ext  # noqa: E402

ROOT = ART.parent
WORKSPACE = ROOT.parent
GEN_DIR = ART / "out" / "gen"
SRC_DIR = ART / "src"

KONTEXT_ENDPOINT = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-kontext-dev"
FLUXDEV_ENDPOINT = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev"

# 与原始少女立绘保持一致：同尺寸、同步数，最大化风格一致性
WIDTH, HEIGHT = PRESETS["girl"]["width"], PRESETS["girl"]["height"]
STEPS = PRESETS["girl"]["steps"]          # 28，落在要求的 28–30 内

# ── 锁定的角色设定表 ──
# 取 girl preset 去掉绿幕段的部分；三个动作共用这一整段，逐字不变。
CHARACTER_SHEET = PRESETS["girl"]["prompt"].replace(CHROMA, "").strip()

# ── 走路四帧（相位驱动步态）──
# 四帧用于「位移 → 相位 → 帧序号」的步态循环，顺序固定为：
#   walk-1 contact-A / walk-2 passing-A / walk-3 contact-B / walk-4 passing-B
# 同一姿态的 A/B 两帧必须**只差左右腿描述**，因此 B 帧由 A 帧把 left/right
# 对调派生（swap_lr），而不是手写两段；再由 assert_walk_frames_consistent()
# 在运行时自检，从代码层面保证「只改左右描述」成立。
#
# 禁止措辞（会让画面飘成跑动或糊掉）：dynamic / running / motion blur
# 关键措辞（重心起伏的唯一来源，必须保留）：torso at its lowest/highest point
WALK_PROMPT = (
    "Anime character in a walk cycle {pose} pose, {legs}, {arms}, "
    "torso at its {torso} point, body upright and facing forward. "
    # 道具必须钉住：不写这句时模型会在不同帧里自行决定镰刀怎么拿，
    # 结果 walk-1/3 竖抱身前、walk-2/4 扛在肩上，逐帧播放像镰刀在闪。
    "Her black-purple scythe with a purple crystal blade stays resting on her "
    "right shoulder in exactly the same position as in the idle reference, "
    "do not move or shift the scythe. "
    # 服装必须逐字复述并置于句末：纯文生图没有参考图，服装只靠文字。
    # 教训：曾在此处写 "bare feet" 与设定表的 "white stockings" 直接矛盾，
    # 服装线索自相冲突后模型把整身重画成紫色长外套，故这里只保留一种说法。
    "Wearing a white and purple off-shoulder gown with pink floral patterns, "
    "criss-cross lacing and long white gloves. "
    "Long silver-lavender hair in a low side ponytail, purple eyes, pointed elf "
    "ears, a small black crown, and a blue flower ornament in her hair. "
    "Bare legs with pink floral patterns, no stockings and no shoes. "
    "2D cel-shaded anime style with clean line art. Plain green background."
)
WALK_BANNED = ("dynamic", "running", "motion blur")
# 每种姿态只描述一次；contact 与 passing 的重心高度差即来自 torso 槽位。
# 步幅必须写足：描述太保守时左右对调后两帧看起来几乎一样，走路节奏读不出来。
WALK_POSES = {
    "A": {
        "pose": "contact",
        "legs": "left leg stepping clearly forward with the heel down and the knee "
                "almost straight, right leg stretched clearly behind with the toe on "
                "the ground, a wide readable stride",
        "arms": "right hand keeping the scythe on her shoulder, left arm swinging "
                "slightly opposite to the legs",
        "torso": "lowest",
        "seed": 401,
    },
    "B": {
        "pose": "passing",
        "legs": "right knee lifted clearly in front with the foot well off the ground, "
                "left leg straight and vertical bearing the weight",
        "arms": "right hand keeping the scythe on her shoulder, left arm near the "
                "neutral position",
        "torso": "highest",
        "seed": 402,
    },
}
WALK_KEYS = ("walk-1", "walk-2", "walk-3", "walk-4")


def swap_lr(text: str) -> str:
    """把 left / right 对调（大小写不敏感）——B 帧相对 A 帧的唯一差异来源。"""
    def repl(m):
        return "right" if m.group(0).lower() == "left" else "left"
    return re.sub(r"\bleft\b|\bright\b", repl, text, flags=re.IGNORECASE)


def walk_action(pose_key: str, swap: bool) -> str:
    """由姿态描述拼出走路提示词；swap=True 得到 left/right 对调的 B 帧。"""
    spec = WALK_POSES[pose_key]
    legs = swap_lr(spec["legs"]) if swap else spec["legs"]
    return WALK_PROMPT.format(pose=spec["pose"], legs=legs,
                              arms=spec["arms"], torso=spec["torso"])


def walk_entry(pose_key: str, swap: bool, out_png: str) -> dict:
    spec = WALK_POSES[pose_key]
    return {
        "out_png": out_png,
        "seed": spec["seed"],
        # legs 只作自检用的元数据，不参与拼提示词
        "legs": swap_lr(spec["legs"]) if swap else spec["legs"],
        "action": walk_action(pose_key, swap),
    }

ACTIONS: dict[str, dict] = {
    "lookback": {
        "out_png": "girl-lookback.png",
        "seed": 101,
        "action": (
            "Show the character glancing back over her shoulder in a subtle motion, "
            "as if reacting to a sound behind her. Turn her head and upper body slightly. "
            "Keep the same facial features, hairstyle, silver hair color, violet eyes, "
            "outfit design, and overall 2D cel-shaded art style."
        ),
    },
    "lean": {
        "out_png": "girl-lean.png",
        "seed": 202,
        "action": (
            "Show the character leaning slightly in one direction, with her body tilted "
            "as if being gently pulled sideways. Keep her feet planted and body posture natural. "
            "Maintain the same facial features, outfit, and art style."
        ),
    },
    "feed": {
        "out_png": "girl-feed.png",
        "seed": 303,
        "action": (
            "Show the character with a delighted expression, smiling with her eyes slightly "
            "closed, one hand raised near her face. Keep the same facial features, hairstyle, "
            "outfit, and overall art style."
        ),
    },
    # 走路已改为四帧相位驱动。每帧都从**原始立绘**独立生成（同一锁定设定表
    # + 同一 seed），禁止链式迭代：B 帧不经过 A 帧。
    "walk-1": walk_entry("A", False, "girl-walk-1.png"),   # contact-A
    "walk-2": walk_entry("B", False, "girl-walk-2.png"),   # passing-A
    "walk-3": walk_entry("A", True, "girl-walk-3.png"),    # contact-B
    "walk-4": walk_entry("B", True, "girl-walk-4.png"),    # passing-B
}


def assert_walk_frames_consistent() -> None:
    """走路四帧自检：同姿态的 A/B 两帧必须**只**差左右腿描述，且措辞合规。"""
    # 1) contact-A/walk-3 与 passing-A/walk-4 各自归一化后必须完全相同
    for a, b in (("walk-1", "walk-3"), ("walk-2", "walk-4")):
        norm = []
        for key in (a, b):
            text = ACTIONS[key]["action"]
            legs = ACTIONS[key]["legs"]
            if legs not in text:
                raise SystemExit(f"{key} 的提示词里找不到腿的描述：{legs!r}")
            norm.append(text.replace(legs, "{LEGS}"))
        if norm[0] != norm[1]:
            raise SystemExit(
                f"{a} / {b} 的提示词除腿的描述外还有其它差异，违反「只改左右描述」的约束")
        if ACTIONS[a]["legs"] == ACTIONS[b]["legs"]:
            raise SystemExit(f"{b} 没有把 left/right 对调")
    # 2) 输出名不能重复
    names = [ACTIONS[k]["out_png"] for k in WALK_KEYS]
    if len(set(names)) != len(names):
        raise SystemExit(f"走路帧的输出名有重复：{names}")
    # 3) 禁止措辞
    for key in WALK_KEYS:
        low = ACTIONS[key]["action"].lower()
        for bad in WALK_BANNED:
            if bad in low:
                raise SystemExit(f"{key} 含禁止措辞 {bad!r}（会飘成跑动或糊掉）")
    # 4) 关键措辞：重心起伏的提示词来源
    for key, phrase in (("walk-1", "torso at its lowest point"),
                        ("walk-2", "torso at its highest point"),
                        ("walk-3", "torso at its lowest point"),
                        ("walk-4", "torso at its highest point")):
        if phrase not in ACTIONS[key]["action"]:
            raise SystemExit(f"{key} 缺少关键措辞 {phrase!r}（重心起伏的唯一来源）")


# ── 提示词触发词替换 ──
# 实测（同 seed 101、同尺寸步数，**仅此一处差异**）：
#   "...violet eyes..."  -> 静默全黑：HTTP 200、最亮像素 0、6.5 KB、耗时 4.0s
#   "...purple eyes..."  -> 正常：118.9 KB、最亮像素 255、耗时 8.0s
# 该端点在若干措辞下会返回纯黑图（无错误、JSON 合法、体积明显偏小），
# 因此在构建提示词时做等价替换；动作原文保持原样以便追溯改了什么。
TRIGGER_REPLACEMENTS = (("violet", "purple"),)


def build_prompt(action_key: str):
    """锁定的设定表 + 该动作子句 + 绿幕约定（绿幕放最后）。返回 (prompt, 替换说明)。"""
    action = ACTIONS[action_key]["action"]
    notes = []
    for bad, good in TRIGGER_REPLACEMENTS:
        if re.search(re.escape(bad), action, re.IGNORECASE):
            action = re.sub(re.escape(bad), good, action, flags=re.IGNORECASE)
            notes.append(f"{bad} -> {good}")
    return f"{CHARACTER_SHEET} {action} {CHROMA}", notes


def post(endpoint: str, payload: dict, key: str, timeout: int):
    """返回 (status, body_bytes)；网络异常返回 (None, 文本)。"""
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except Exception as exc:  # noqa: BLE001
        return None, str(exc).encode()


def extract_image(body: bytes) -> bytes | None:
    try:
        doc = json.loads(body.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    artifacts = doc.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        return None
    b64 = artifacts[0].get("base64")
    if not b64:
        return None
    return base64.b64decode(b64)


def detail_of(body: bytes, limit: int = 220) -> str:
    text = body.decode("utf-8", "replace").strip()
    try:
        doc = json.loads(text)
        d = doc.get("detail")
        if isinstance(d, str):
            return d[:limit]
        if isinstance(d, list):
            return "; ".join(str(x.get("msg", x)) for x in d)[:limit]
    except Exception:  # noqa: BLE001
        pass
    return text[:limit]


def try_img2img(key: str, image: Path, prompt: str, seed: int, timeout: int):
    """按任务指定方式尝试 kontext 图生图。返回 (data|None, reason)。"""
    b64 = base64.b64encode(image.read_bytes()).decode("ascii")
    payload = {
        # 任务要求 image 走 base64；实测该端点只认 example_id，这一步就是为了
        # 把「不可用」这件事以可复现的方式记录下来，而不是默默换方案。
        "image": "data:image/jpeg;base64," + b64,
        "prompt": prompt,
        "steps": STEPS,
        "seed": seed,
    }
    status, body = post(KONTEXT_ENDPOINT, payload, key, timeout)
    if status == 200:
        data = extract_image(body)
        if data is None:
            return None, "HTTP 200 但响应里没有 artifacts[0].base64"
        return data, ""
    return None, f"HTTP {status}: {detail_of(body)}"


def gen_t2i(key: str, prompt: str, seed: int, timeout: int):
    """flux.1-dev 文生图（唯一可用路径）。返回 (data|None, reason)。"""
    payload = {
        "prompt": prompt,
        "width": WIDTH,
        "height": HEIGHT,
        "steps": STEPS,
        "seed": seed,
    }
    status, body = post(FLUXDEV_ENDPOINT, payload, key, timeout)
    if status == 200:
        data = extract_image(body)
        if data is None:
            return None, "HTTP 200 但响应里没有 artifacts[0].base64"
        return data, ""
    return None, f"HTTP {status}: {detail_of(body)}"


def run_cutout(raw: Path, out_png: Path, green_input: bool) -> int:
    """调用既有 cutout.py（阈值自动标定）。stdio 直接继承，不走管道。"""
    args = [sys.executable, str(ART / "cutout.py"), str(raw), str(out_png),
            "--check", str(raw.with_name(raw.stem + "-check.png"))]
    if not green_input:
        # 输入不是绿幕（例如透明 PNG 贴到绿幕之前）时需要先合成绿幕；
        # 当前流程始终从绿幕原图出发，因此这里只是兜底提示。
        print("    注意：输入并非绿幕原图，抠图结果可能不可靠")
    return subprocess.run(args).returncode


def _make_stdout_forgiving() -> None:
    """Windows 控制台编码常为 GBK，打印非 GBK 字符会抛 UnicodeEncodeError
    并**中断整轮生成**（实测踩过：一个符号就让已经生成好的图没被处理）。
    这里把错误策略改成 replace，宁可显示成问号也不要中断。"""
    try:
        sys.stdout.reconfigure(errors="replace")
        sys.stderr.reconfigure(errors="replace")
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    _make_stdout_forgiving()
    ap = argparse.ArgumentParser(
        description="为桌宠生成动作立绘变体（每动作一次独立调用，不链式迭代）")
    ap.add_argument("--actions", default="lookback,feed,walk-1,walk-2,walk-3,walk-4",
                    help="逗号分隔。默认是客户端实际使用的六张"
                         "（lean 已不再被拖拽引用，需要时显式指定）")
    ap.add_argument("--method", choices=("auto", "img2img", "t2i"), default="auto",
                    help="auto=先试图生图、失败则切文生图（默认）；img2img=只用 kontext；t2i=只用 flux.1-dev")
    ap.add_argument("--input", default=str(GEN_DIR / "girl-raw.jpg"),
                    help="图生图输入（默认原始绿幕立绘）")
    ap.add_argument("--seed-offset", type=int, default=0, help="整体平移种子，便于重跑")
    ap.add_argument("--seed", type=int, default=None,
                    help="强制所有动作使用同一个种子（强烈建议用原始立绘的种子，"
                         "文生图里基础噪声极大决定角色设计，同种子能显著贴近原图；"
                         "原始立绘是 seed=7）")
    ap.add_argument("--key-file", default=None)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--no-cutout", action="store_true", help="只生成原始图，不跑抠图")
    args = ap.parse_args()

    key = read_key(Path(args.key_file) if args.key_file else None)
    image = Path(args.input)
    if args.method in ("auto", "img2img") and not image.is_file():
        raise SystemExit(f"图生图输入不存在：{image}")

    names = [n.strip() for n in args.actions.split(",") if n.strip()]
    unknown = [n for n in names if n not in ACTIONS]
    if unknown:
        raise SystemExit(f"未知动作：{unknown}；可选 {sorted(ACTIONS)}")

    # 约束自检：走路四帧的提示词必须只差左右腿描述，且措辞合规
    assert_walk_frames_consistent()
    if any(n in WALK_KEYS for n in names):
        print("走路四帧提示词自检通过：同姿态两帧仅左右描述不同，"
              "无 dynamic/running/motion blur，含重心起伏关键措辞")

    print(f"角色设定表（三动作共用，{len(CHARACTER_SHEET)} 字符）已锁定")
    print(f"尺寸 {WIDTH}x{HEIGHT}  步数 {STEPS}")
    if args.method != "t2i":
        print(f"图生图端点 {KONTEXT_ENDPOINT}")
        print(f"图生图输入 {image}")
    results = []

    for name in names:
        spec = ACTIONS[name]
        seed = (spec["seed"] if args.seed is None else args.seed) + args.seed_offset
        prompt, notes = build_prompt(name)
        print(f"\n{'=' * 72}\n动作 {name}   seed={seed}   目标 art/src/{spec['out_png']}")
        print(f"动作子句：{spec['action'][:96]}...")
        if notes:
            print(f"  提示词触发词替换：{', '.join(notes)}"
                  f"（该措辞实测会返回全黑图，见脚本顶部说明）")

        data = None
        method_used = ""

        if args.method in ("auto", "img2img"):
            t0 = time.time()
            data, reason = try_img2img(key, image, prompt, seed, args.timeout)
            if data is not None:
                method_used = "kontext 图生图"
                print(f"  图生图成功（{time.time() - t0:.1f}s）")
            else:
                print(f"  图像生图不可用：{reason}")
                if args.method == "img2img":
                    print("  --method img2img 要求只走这条路，跳过该动作")
                    results.append((name, False, reason))
                    continue
                print("  -> 切换到 flux.1-dev 文生图（锁定设定表）")

        if data is None and args.method in ("auto", "t2i"):
            t0 = time.time()
            data, reason = gen_t2i(key, prompt, seed, args.timeout)
            if data is not None:
                method_used = "flux.1-dev 文生图"
                print(f"  文生图成功（{time.time() - t0:.1f}s）")
            else:
                print(f"  文生图失败：{reason}")
                results.append((name, False, reason))
                continue

        if data is None:
            results.append((name, False, "没有拿到图像"))
            continue

        # ── 全黑守卫（与 gen.py 同源）：拒绝写出无效内容 ──
        peak = blank_peak(data)
        if peak is not None and peak < 4:
            print(f"  [X] 检测到全黑输出（最亮像素 {peak}），文件未写出")
            results.append((name, False, f"全黑输出 peak={peak}"))
            continue

        ext = sniff_ext(data)
        raw = GEN_DIR / f"action-{name}-raw{ext}"
        GEN_DIR.mkdir(parents=True, exist_ok=True)
        raw.write_bytes(data)
        print(f"  写出原始图 {raw.name}  {len(data)/1024:.1f} KB  最亮像素 {peak}  "
              f"来源[{method_used}]")

        out_png = SRC_DIR / spec["out_png"]
        if args.no_cutout:
            print("  （--no-cutout：跳过抠图）")
            results.append((name, True, method_used))
            continue

        rc = run_cutout(raw, out_png, green_input=True)
        if rc != 0:
            print(f"  [X] 抠图失败 exit={rc}")
            results.append((name, False, "抠图失败"))
            continue
        results.append((name, True, method_used))

    print(f"\n{'=' * 72}\n小结")
    for name, ok, info in results:
        flag = "OK " if ok else "FAIL"
        print(f"  [{flag}] {name:9s} {info}")
    okc = sum(1 for _, ok, _ in results if ok)
    print(f"  {okc}/{len(results)} 个动作产出成功")
    return 0 if okc == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
