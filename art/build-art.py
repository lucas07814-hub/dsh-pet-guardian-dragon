"""
占位美术生成器 —— dsh-pet-guardian-dragon

从用户提供的参考图里裁出两个可独立动画的元素：
  - girl   : 少女主体（待机 / 拖拽 / 点击 / 投喂 都以它为主体）
  - dragon : 守护龙影（浮游、回眸）
  - avatar : 头像小方块（标题栏常驻模式用）

为什么是「占位」：真正的透明底分层立绘需要生图能力，而本机当前尚未接入生图模型。
本脚本用软边圆角遮罩把参考图的矩形边界处理掉，使素材能直接合成到 DSH 界面上
而不显得突兀。整条管线与具体生图模型无关：接入新模型后，把它产出的图替换
art/out/ 下的同名产物（或按需调整下面的裁切框）再重跑构建即可。

用法：
  python art/build-art.py <参考图路径>
"""

from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "art" / "out"
OUT.mkdir(parents=True, exist_ok=True)


def detect_panel_top(im: Image.Image) -> int:
    """返回底部文字面板的起始行。

    面板底色极暗（中位数≈39），插画区很亮（中位数 150~200），而面板里的
    **文字行**会把中位数抬到 60~85。因此用 100 作阈值：从下往上找到第一行
    中位数 > 100 的插画行，其下一行即面板顶。这样对文字行完全免疫。
    """
    w, h = im.size
    small = im.resize((64, h)).convert("L")
    px = small.load()
    limit = int(h * 0.50)

    def row_median(y: int) -> float:
        vals = sorted(px[x, y] for x in range(64))
        return (vals[31] + vals[32]) / 2.0

    for y in range(h - 1, limit, -1):
        if row_median(y) > 100:
            return y + 1
    return h


def rounded_mask(size: tuple[int, int], radius_ratio: float, feather: int) -> Image.Image:
    """生成柔化过的圆角矩形遮罩（L 模式）。"""
    w, h = size
    ss = 4  # 超采样，避免圆角锯齿
    m = Image.new("L", (w * ss, h * ss), 0)
    d = ImageDraw.Draw(m)
    r = int(min(w, h) * radius_ratio) * ss
    d.rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), radius=r, fill=255)
    m = m.resize((w, h), Image.LANCZOS)
    if feather > 0:
        m = m.filter(ImageFilter.GaussianBlur(feather))
    return m


def apply_mask(im: Image.Image, radius_ratio: float, feather: int) -> Image.Image:
    rgba = im.convert("RGBA")
    mask = rounded_mask(rgba.size, radius_ratio, feather)
    # 保留原图自身的 alpha（若有）
    if im.mode in ("RGBA", "LA"):
        existing = im.convert("RGBA").getchannel("A")
        mask = Image.composite(mask, Image.new("L", mask.size, 0), existing)
    rgba.putalpha(mask)
    return rgba


def fit(im: Image.Image, box: tuple[int, int], resample=Image.LANCZOS) -> Image.Image:
    """等比缩放到能放进 box 的最大尺寸。"""
    c = im.copy()
    c.thumbnail(box, resample)
    return c


def pad_to_square(im: Image.Image, size: int) -> Image.Image:
    """把图居中贴到 size×size 的透明画布上。

    形态 A 的规格写明「建议尺寸：512×512 px」，而站位立绘是竖长的，
    直接输出会造成尺寸不一致；统一贴到 512 方画布后，宠物在 UI 里的
    包围盒可预测，缩放与定位也更好算。
    """
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x = (size - im.width) // 2
    y = (size - im.height) // 2
    canvas.paste(im, (x, y), im)
    return canvas


# ─────────────── 外部生图入口（与具体生图模型无关） ───────────────
#
# 接入任意生图模型后，把它产出的图按下面的文件名放进 art/src/ 即可，
# 本脚本会优先使用它们，不再走参考图裁切：
#
#   art/src/girl.png    少女主体（建议：透明底全身立绘）
#   art/src/dragon.png  守护龙影（建议：透明底）
#   art/src/avatar.png  标题栏头像（建议：方形/透明底）
#
# 判定规则：文件存在且**确实含透明像素**时视为真抠图，直接使用、不加遮罩；
# 若存在但不含透明通道，则退回「软边圆角遮罩」并打印提示，避免出现硬边矩形。
# 支持 .png / .webp / .jpg；alpha 只可能存在于前两者。

SRC = ROOT / "art" / "src"
OVERRIDE_EXTS = (".png", ".webp", ".jpg", ".jpeg")


def load_override(name: str):
    """在 art/src/ 里找同名覆盖图；返回 (路径, RGBA 图) 或 (None, None)。"""
    for ext in OVERRIDE_EXTS:
        candidate = SRC / f"{name}{ext}"
        if candidate.is_file():
            return candidate, Image.open(candidate).convert("RGBA")
    return None, None


def has_real_alpha(im: Image.Image) -> bool:
    """是否真的带透明像素（而不是不透明的 PNG）。"""
    lo, _hi = im.getchannel("A").getextrema()
    return lo < 250


def build_asset(name: str, fallback: Image.Image, canvas: int,
                radius: float, feather: int):
    """产出一个方画布素材，并返回其来源说明。

    优先用 art/src/ 的外部生图；没有则用参考图裁切结果并套软边遮罩。
    """
    path, override = load_override(name)

    if override is not None and has_real_alpha(override):
        out = pad_to_square(fit(override, (canvas, canvas)), canvas)
        return out, f"art/src/{path.name}（外部生图·含透明通道）"

    if override is not None:
        note = f"art/src/{path.name}（外部生图·无透明通道→套软边遮罩）"
        base = override
    else:
        note = "参考图裁切＋软边遮罩"
        base = fallback

    masked = apply_mask(fit(base, (canvas, canvas)), radius, feather)
    return pad_to_square(masked, canvas), note


def main() -> int:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "")

    # 参考图是**可选**的：一旦 art/src/ 里三张外部生图齐了，就不该再依赖它。
    # 缺图时退化为透明占位，缺哪张由 build_asset 打印来源说明。
    ref_available = src.is_file()
    if ref_available:
        im = Image.open(src).convert("RGB")
        W, H = im.size
        panel_top = detect_panel_top(im)
        print(f"source   : {W}x{H}")
        print(f"panel_top: {panel_top} (illustration height {panel_top})")
    else:
        print(f"参考图不可用（{src or '未提供'}）—— 只使用 art/src/ 下的外部生图")
        W, H = 1152, 1920
        panel_top = H
        im = Image.new("RGB", (W, H), (0, 0, 0))


    illo = im.crop((0, 0, W, panel_top))

    # ---- 裁切框（相对原图比例，依据参考图构图标定）----
    # 少女主体：居中站立，从头顶到裙摆
    gx0, gx1 = int(W * 0.20), int(W * 0.68)
    gy0, gy1 = int(H * 0.18), min(int(H * 0.83), panel_top)
    girl = illo.crop((gx0, gy0, gx1, gy1))

    # 守护龙影：环绕上半部的龙
    dx0, dx1 = int(W * 0.04), W
    dy0, dy1 = int(H * 0.03), min(int(H * 0.80), panel_top)
    dragon = illo.crop((dx0, dy0, dx1, dy1))

    # 头像：头部到胸口
    side = int(W * 0.30)
    ax = int(W * 0.29)
    ay = int(H * 0.19)
    avatar = illo.crop((ax, ay, ax + side, min(ay + side, panel_top)))

    # ---- 输出 ----
    # 主美术统一为 512×512（形态 A 规格的「建议尺寸」）。
    # 头像保持 256：它只用于标题栏 18px 的小图标，做成 512 会白白撑大
    # 内联进 client bundle 的 base64。
    CANVAS = 512
    AVATAR = 256
    assets = {}
    origins = {}

    specs = (
        ("girl",   girl,   CANVAS, 0.10, 3, 88),
        ("dragon", dragon, CANVAS, 0.22, 6, 88),
        ("avatar", avatar, AVATAR, 0.30, 2, 90),
    )
    for name, fallback, canvas, radius, feather, quality in specs:
        out, origin = build_asset(name, fallback, canvas, radius, feather)
        out.save(OUT / f"{name}.webp", "WEBP", quality=quality, method=6)
        assets[name] = (OUT / f"{name}.webp", out.size)
        origins[name] = origin

    # ── 动作立绘变体 ──
    # 由 art/gen-actions.py 生成（art/src/girl-lookback.png 等）。
    # 回退用**已生成的主立绘**而不是参考图裁切：动作变体缺失时退回待机立绘，
    # 视觉上只是「该动作没有专属图」，绝不会退化成参考图那种矩形块。
    girl_asset = Image.open(assets["girl"][0])
    for name, radius, feather in (
        ("girl-lookback", 0.10, 3),
        ("girl-lean",     0.10, 3),   # 拖拽已改用走路帧；保留生成能力以便回退
        ("girl-feed",     0.10, 3),
        ("girl-walk-1",   0.10, 3),   # 走路四帧（相位驱动）：contact-A
        ("girl-walk-2",   0.10, 3),   #                        passing-A
        ("girl-walk-3",   0.10, 3),   #                        contact-B（左右对调）
        ("girl-walk-4",   0.10, 3),   #                        passing-B（左右对调）
    ):
        out, origin = build_asset(name, girl_asset, CANVAS, radius, feather)
        out.save(OUT / f"{name}.webp", "WEBP", quality=88, method=6)
        assets[name] = (OUT / f"{name}.webp", out.size)
        origins[name] = origin

    # 同时导出 PNG 预览，便于人工查看
    for name, (path, _size) in assets.items():
        Image.open(path).save(OUT / f"{name}-preview.png")

    # ---- 生成内联数据表（客户端 bundle 只能带自己的字节，图片必须内联）----
    table = {}
    for name, (path, _size) in assets.items():
        raw = path.read_bytes()
        table[name] = "data:image/webp;base64," + base64.b64encode(raw).decode("ascii")
        print(f"{name:7s}: {path.name}  {_size[0]}x{_size[1]}  {len(raw)/1024:6.1f} KB   <- {origins[name]}")
    (ROOT / "art" / "art-data.json").write_text(
        json.dumps(table, ensure_ascii=False), encoding="utf-8"
    )
    total = sum(len(v) for v in table.values())
    print(f"inline data URI total: {total/1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
