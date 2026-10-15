"""
绿幕抠图 —— 把生图产出的纯色背景 JPEG 转成带 alpha 的透明 PNG

为什么需要它：NVIDIA 的 FLUX.1-dev 只返回 JPEG（无 alpha 通道），
所以透明底必须靠「纯色幕布 + 后期抠图」实现。

为什么用绿幕：形态 A 的角色配色是银发 / 白紫裙 / 粉色花 / 黑色镰刀 / 紫色眼睛，
**不含绿色**，因此绿幕与主体在色度上可分离。

做法（不是简单的颜色替换）：
  1. 用 **绿优势度** g = G - max(R,B) 作为分离量，对光照渐变鲁棒
     （比「匹配某个具体绿色」更能容忍幕布明暗不均）
  2. 以 lo/hi 两个阈值做**平滑过渡**，得到软边 alpha，避免锯齿
  3. 形态学清理：从四角 flood fill 找出真正的「外部」，填补主体内部的孔洞；
     再做开运算去掉孤立噪点
  4. **去绿溢**（despill）：把边缘像素的绿色分量压到 R/B 均值，
     消除主体边缘的绿色描边
  5. 按内容包围盒裁紧，便于后续统一贴到方画布

用法：
  python art/cutout.py <输入图> <输出.png> [--lo 10] [--hi 46] [--check 叠加预览.png]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ALPHA_HOLE_FILL = 128


def greenness(rgb: np.ndarray) -> np.ndarray:
    """绿优势度：绿幕明显为正，主体（银/白/紫/粉/黑）接近 0 或为负。"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return g - np.maximum(r, b)


def calibrate_bg(rgb: np.ndarray, margin_frac: float = 0.03) -> float:
    """从画面**边缘环带**估计幕布的绿优势度。

    为什么必须自动标定：不同提示词/种子出来的幕布绿色深浅差别很大 ——
    实测少女图边缘绿优势度 64、头像 80，而龙首只有 37。写死阈值会让后者
    的背景被判成半透明（bbox 收不紧、边缘留一层绿雾）。
    """
    h, w = rgb.shape[:2]
    m = max(2, int(min(h, w) * margin_frac))
    ring = np.concatenate([
        rgb[:m].reshape(-1, 3),
        rgb[-m:].reshape(-1, 3),
        rgb[:, :m].reshape(-1, 3),
        rgb[:, -m:].reshape(-1, 3),
    ])
    return float(np.median(greenness(ring)))


def build_alpha(rgb: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """由绿优势度构造软边 alpha（1 = 主体，0 = 背景）。"""
    g = greenness(rgb)
    # g <= lo        -> 必是主体   -> alpha 1
    # g >= hi        -> 必是背景   -> alpha 0
    a = (hi - g) / max(1e-6, (hi - lo))
    return np.clip(a, 0.0, 1.0)


def fill_holes_and_despeckle(binary: np.ndarray) -> np.ndarray:
    """从四角 flood fill 标出真正的「外部」，再填补内部孔洞并去噪点。"""
    h, w = binary.shape
    img = Image.fromarray(binary.astype(np.uint8) * 255, mode="L")
    d = ImageDraw.Draw(img)

    # 四边中点的背景像素作为种子（角落可能被主体占住）
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for seed in seeds:
        if img.getpixel(seed) == 0:
            ImageDraw.floodfill(img, seed, ALPHA_HOLE_FILL, thresh=0)

    arr = np.array(img)
    outside = arr == ALPHA_HOLE_FILL
    holes = (arr == 0) & (~outside)      # 被主体包围的背景 -> 视为主体内部
    filled = (arr > 0) | holes

    # 开运算：先腐蚀去掉毛刺与孤立点，再膨胀还原主体
    m = Image.fromarray((filled * 255).astype(np.uint8), mode="L")
    m = m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    return np.array(m) > 127


def despill(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """把半透明/边缘像素的绿色压到 R、B 均值，消除绿色描边。"""
    out = rgb.astype(np.float32).copy()
    r, g, b = out[..., 0], out[..., 1], out[..., 2]
    limit = (r + b) / 2.0
    excess = g - limit
    needs = (excess > 0) & (alpha < 1.0)
    g[needs] = limit[needs]
    return np.clip(out, 0, 255).astype(np.uint8)


def main() -> int:
    ap = argparse.ArgumentParser(description="绿幕抠图")
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--lo", type=float, default=None,
                    help="低于此绿优势度=纯主体（默认按边缘自动标定）")
    ap.add_argument("--hi", type=float, default=None,
                    help="高于此绿优势度=纯背景（默认按边缘自动标定）")
    ap.add_argument("--erode", type=int, default=1, help="alpha 内缩像素，进一步去绿边")
    ap.add_argument("--feather", type=float, default=0.8, help="边缘柔化半径")
    ap.add_argument("--check", default=None, help="叠加到品红底上的预览图路径")
    args = ap.parse_args()

    src = Path(args.src)
    im = Image.open(src).convert("RGB")
    arr = np.asarray(im).astype(np.float32)
    print(f"输入 {src.name}  {im.size[0]}x{im.size[1]}")

    # 阈值按边缘幕布自动标定：不同图之间的幕布绿色深浅差别很大
    bg_g = calibrate_bg(arr)
    if bg_g < 10:
        print(f"警告: 边缘绿优势度仅 {bg_g:.1f}，几乎检测不到绿幕 —— "
              f"这张图可能不是绿幕渲染，抠图结果不可靠。", file=sys.stderr)
    lo = args.lo if args.lo is not None else max(2.0, bg_g * 0.15)
    hi = args.hi if args.hi is not None else max(lo + 4.0, bg_g * 0.60)
    manual = args.lo is not None or args.hi is not None
    print(f"幕布绿优势度（边缘中位数）= {bg_g:.1f}  ->  lo={lo:.1f}  hi={hi:.1f}"
          f"{'  [手动]' if manual else '  [自动标定]'}")

    alpha = build_alpha(arr, lo, hi)
    binary = alpha > 0.5
    print(f"背景判定：绿优势度 >= {hi:.1f} 的像素占比 {float((greenness(arr) >= hi).mean()) * 100:.1f}%")

    cleaned = fill_holes_and_despeckle(binary)
    # 只有「清理后的主体」保留，且用软边 alpha 作为边界
    alpha = np.where(cleaned, alpha, 0.0)

    if args.erode > 0:
        a_img = Image.fromarray((alpha * 255).astype(np.uint8), mode="L")
        for _ in range(args.erode):
            a_img = a_img.filter(ImageFilter.MinFilter(3))
        alpha = np.array(a_img).astype(np.float32) / 255.0

    if args.feather > 0:
        a_img = Image.fromarray((alpha * 255).astype(np.uint8), mode="L")
        a_img = a_img.filter(ImageFilter.GaussianBlur(args.feather))
        alpha = np.array(a_img).astype(np.float32) / 255.0

    rgb = despill(np.asarray(im), alpha)

    out = np.dstack([rgb, (alpha * 255).astype(np.uint8)])
    rgba = Image.fromarray(out, mode="RGBA")

    # 按内容裁紧（留一点余量），后续统一贴方画布
    bbox = rgba.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if bbox:
        pad = 4
        bbox = (max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                min(rgba.width, bbox[2] + pad), min(rgba.height, bbox[3] + pad))
        rgba = rgba.crop(bbox)
    print(f"抠图后 {rgba.size[0]}x{rgba.size[1]}   不透明占比 "
          f"{float((alpha > 0.5).mean()) * 100:.1f}%")

    dst = Path(args.dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    rgba.save(dst, "PNG")
    print("写入:", dst, f"{dst.stat().st_size/1024:.1f} KB")

    if args.check:
        bg = Image.new("RGB", rgba.size, (255, 0, 255))
        bg.paste(rgba, (0, 0), rgba)
        cp = Path(args.check)
        bg.save(cp, "PNG")
        print("叠加预览:", cp)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
