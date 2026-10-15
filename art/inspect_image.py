"""
图片快速体检 —— 打印尺寸、格式、以及若干横向色带的均值 RGB。

**为什么不叫 inspect.py**：那会与 Python 标准库的 `inspect` 模块重名。
运行 `python art/<任何脚本>.py` 时，脚本所在目录会被放进 `sys.path[0]`，
于是 numpy 内部一句 `import inspect` 就会加载到这个文件。当时它没有
`__main__` 守卫，被导入即执行，随后 numpy 因拿不到 `inspect.cleandoc`
而崩溃，报错位置完全指不到真正的原因。

教训：工具脚本不要用标准库模块名（inspect / json / types / code / copy …），
并且一律加 `if __name__ == "__main__"` 守卫。

用法：
  python art/inspect_image.py <图片> [<图片> ...]
"""

from __future__ import annotations

import sys

from PIL import Image


def report(path: str) -> None:
    with Image.open(path) as raw:
        print(f"{path}")
        print(f"  format={raw.format} size={raw.size} mode={raw.mode}")
        im = raw.convert("RGB")
    w, h = im.size
    for frac in (0.1, 0.4, 0.7, 0.8, 0.85, 0.95):
        y = min(h - 1, int(h * frac))
        band = im.crop((0, y, w, y + 1))
        px = list(band.getdata())
        mean = tuple(sum(c[i] for c in px) // len(px) for i in range(3))
        print(f"  y={frac:.2f} mean_rgb={mean}")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    for path in sys.argv[1:]:
        report(path)
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
