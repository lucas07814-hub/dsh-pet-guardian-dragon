"""
NVIDIA FLUX.1-dev 生图客户端（纯标准库，无需 pip 安装）

为什么用纯标准库：本机 pnpm/npm/git 都被沙箱挡住，装不了依赖；而 urllib 自带，
且 Python 用的是内置 OpenSSL 而不是 Windows Schannel —— 后者在沙箱里会报
SEC_E_NO_CREDENTIALS，这也正是 curl.exe 与 PowerShell 都连不通的原因。

已验证的接口事实（2026-10-13 实测）：
  * 端点   POST https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev
  * 鉴权   Authorization: Bearer <NVIDIA_API_KEY>（nvapi- 开头）
  * 必填   prompt
  * 尺寸   width/height 只能取 768,832,896,960,1024,1088,1152,1216,1280,1344
  * 步数   steps >= 5
  * 禁用   aspect_ratio 等额外字段会导致 422 extra_forbidden
  * 响应   {"artifacts":[{"base64":"<JPEG>"}]}  —— 是 JPEG，无 alpha 通道

用法：
  python art/gen.py --prompt "..." --out art/out/gen/raw.jpg
  python art/gen.py --preset girl            # 用内置提示词
  python art/gen.py --preset girl --steps 28 --seed 7

密钥读取优先级：--key-file > 环境变量 NVIDIA_API_KEY > 工作区根的 .nvidia-key
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = ROOT.parent

ENDPOINT = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev"
DEFAULT_KEY_FILE = WORKSPACE / ".nvidia-key"
ALLOWED_SIZES = (768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344)

# ── 绿幕约定 ──
# 该模型只出 JPEG（无 alpha），所以要走「纯色幕布 + 后期抠图」这条路。
# 角色配色是银发 / 白紫裙 / 紫焰，**不含绿色**，因此绿幕最安全。
CHROMA = (
    "The background is a completely flat, solid, uniform chroma-key green (#00FF00) "
    "with absolutely no gradient, no texture, no shadows, no vignette and no other objects. "
    "The character is fully separated from the background with clean crisp edges. "
    "No green light is reflected onto the character. "
)

PRESETS: dict[str, dict] = {
    "girl": {
        "width": 896,
        "height": 1216,
        "steps": 28,
        "prompt": (
            "Full-body anime character illustration, cel-shaded, clean line art, standing pose, "
            "facing slightly toward the viewer. Character: a young elf girl with long silver-lavender "
            "hair in a low side ponytail, purple eyes, pointed elf ears, a small black crown, and a blue "
            "flower ornament in her hair; a white and purple off-shoulder gown with pink floral patterns "
            "and criss-cross lacing, long gloves, white stockings with floral motifs; holding a long "
            "black-purple scythe with a purple crystal blade. Calm, gentle expression. "
            "Entire figure fully inside the frame, head to feet visible. "
            + CHROMA
        ),
    },
    "dragon": {
        "width": 1024,
        "height": 1024,
        "steps": 28,
        "prompt": (
            "Portrait of a white oriental dragon head and long neck, purple glowing eyes, "
            "purple mane and horns, anime cel-shaded illustration, clean line art, "
            "majestic yet gentle expression, facing the viewer. Centered, fully inside the frame. "
            # 注意：实测描述「整条盘绕的龙 / 紫罗兰色鳞片」会返回全黑图，
            # 因此这里刻意只写「龙首+长颈」，并**回避 'violet' 与 'coiling'** 这类措辞。
            + CHROMA
        ),
    },
    "avatar": {
        "width": 1024,
        "height": 1024,
        "steps": 24,
        "prompt": (
            "Close-up portrait bust shot of the same young elf girl: long silver-lavender hair, "
            "purple eyes, pointed elf ears, a small black crown, a blue flower hair ornament, "
            "wearing a white and purple off-shoulder gown. Soft gentle smile, looking at the viewer. "
            "Head and shoulders centered and fully inside the frame. "
            + CHROMA
        ),
    },
}


def read_key(key_file: Path | None) -> str:
    if key_file is not None:
        if not key_file.is_file():
            raise SystemExit(f"密钥文件不存在：{key_file}")
        return key_file.read_text(encoding="utf-8").strip()
    env = os.environ.get("NVIDIA_API_KEY", "").strip()
    if env:
        return env
    if DEFAULT_KEY_FILE.is_file():
        return DEFAULT_KEY_FILE.read_text(encoding="utf-8").strip()
    raise SystemExit(
        "找不到密钥。请用 --key-file，或设置环境变量 NVIDIA_API_KEY，"
        f"或把密钥写进 {DEFAULT_KEY_FILE}"
    )


def sniff_ext(data: bytes) -> str:
    """按魔术字节判断真实图片格式（服务端给的是 JPEG）。"""
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ".bin"


def blank_peak(data: bytes) -> int | None:
    """返回图像最亮像素值；无法解码时返回 None。

    为什么需要：实测该接口在某些提示词下会**静默返回一张全黑图**——
    HTTP 200、artifacts[0].base64 正常存在、JSON 完全合法，只是内容是纯黑
    （1024×1024、约 6.3 KB、最亮像素 0）。不主动检测的话，抠图脚本会把它
    当成「100% 不透明的主体」，把一张黑图当成美术素材交付出去。
    """
    try:
        import io

        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(io.BytesIO(data)) as im:
            return im.convert("L").getextrema()[1]
    except Exception:  # noqa: BLE001
        return None


def generate(key: str, payload: dict, timeout: int) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    try:
        doc = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"响应不是 JSON（{exc}）：{raw[:300]!r}") from exc

    artifacts = doc.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise SystemExit(f"响应里没有 artifacts：{json.dumps(doc)[:400]}")
    b64 = artifacts[0].get("base64")
    if not b64:
        raise SystemExit("artifacts[0] 里没有 base64 字段")
    return base64.b64decode(b64)


def main() -> int:
    ap = argparse.ArgumentParser(description="NVIDIA FLUX.1-dev 生图")
    ap.add_argument("--prompt")
    ap.add_argument("--preset", choices=sorted(PRESETS))
    ap.add_argument("--out", default=None, help="输出路径（扩展名会按真实格式修正）")
    ap.add_argument("--width", type=int)
    ap.add_argument("--height", type=int)
    ap.add_argument("--steps", type=int)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--cfg-scale", type=float, default=None)
    ap.add_argument("--mode", default=None, help='可选，例如 "base"')
    ap.add_argument("--key-file", default=None)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--allow-blank", action="store_true",
                    help="即使检测到全黑输出也写出文件（默认拒绝，避免把黑图当素材）")
    args = ap.parse_args()

    if not args.prompt and not args.preset:
        ap.error("需要 --prompt 或 --preset 之一")

    payload: dict = {}
    if args.preset:
        payload.update({k: v for k, v in PRESETS[args.preset].items()})
    if args.prompt:
        payload["prompt"] = args.prompt
    for field, value in (("width", args.width), ("height", args.height),
                         ("steps", args.steps), ("cfg_scale", args.cfg_scale),
                         ("mode", args.mode)):
        if value is not None:
            payload[field] = value
    payload.setdefault("seed", args.seed)

    # 本地先拦一道，避免用 422 换错误信息
    for dim in ("width", "height"):
        if dim in payload and payload[dim] not in ALLOWED_SIZES:
            raise SystemExit(f"{dim}={payload[dim]} 不合法，只能取 {list(ALLOWED_SIZES)}")
    if payload.get("steps") is not None and payload["steps"] < 5:
        raise SystemExit("steps 必须 >= 5")

    key = read_key(Path(args.key_file) if args.key_file else None)
    print("endpoint :", ENDPOINT)
    print("preset   :", args.preset or "(自定义 prompt)")
    print("payload  :", json.dumps({k: (v[:60] + "…" if isinstance(v, str) and len(v) > 60 else v)
                                  for k, v in payload.items()}, ensure_ascii=False))
    print("prompt   :", payload["prompt"][:120].replace("\n", " ") + "…")

    t0 = time.time()
    try:
        data = generate(key, payload, args.timeout)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:600]
        print(f"\nHTTP {exc.code} —— {exc.reason}\n{detail}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"\n连接失败：{exc.reason}\n"
              f"（若为 TLS/凭证类错误，说明该进程被沙箱限制了 TLS；"
              f"Python 用内置 OpenSSL，通常不受 Schannel 限制影响）", file=sys.stderr)
        return 1
    elapsed = time.time() - t0

    ext = sniff_ext(data)
    peak = blank_peak(data)

    # 静默全黑检测：宁可报错，也不要把一张黑图落成「美术素材」
    if peak is not None and peak < 4 and not args.allow_blank:
        print(f"\n检测到**全黑输出**（最亮像素 {peak}，{len(data)/1024:.1f} KB，耗时 {elapsed:.1f}s）。"
              f"接口返回了 HTTP 200 但内容无效。", file=sys.stderr)
        print("建议依次尝试：换个 seed、改写措辞（实测含 'violet' 的提示词屡次触发）、"
              "简化描述、或换用其它模型。", file=sys.stderr)
        print("文件**未写出**，避免被误当作素材。确需保留请加 --allow-blank。", file=sys.stderr)
        return 2

    out = Path(args.out) if args.out else (ROOT / "art" / "out" / "gen" / f"{args.preset or 'gen'}{ext}")
    if out.suffix.lower() != ext:
        out = out.with_suffix(ext)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)

    print(f"\nOK  {elapsed:.1f}s  {len(data)/1024:.1f} KB  格式 {ext}  最亮像素 {peak}")
    print("写入:", out)
    if ext != ".png":
        print("注意: 服务端返回的是无 alpha 的格式；透明底需靠绿幕 + 后期抠图（art/cutout.py）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
