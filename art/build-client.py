r"""
零构建客户端 bundle 组装器 —— dsh-pet-guardian-dragon

把 src/client.template.js 包进 DeepSeek Harness 官方的 lazy-CJS factory 外壳，
并把美术数据内联进去，产出 lib/client.js。

外壳格式严格照抄官方预设 packages/client/tsdown.client.ts 的
outputOptions.banner / intro / footer 三件套：

    window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    <bundle body>
    return module.exports; } });

用法：
  python art/build-client.py
  python art/build-client.py --node "C:/path/to/node.exe"

node 解释器只用于对产物跑一遍 `node --check`。定位顺序（不硬编码任何个人目录）：
  1. --node 参数
  2. 环境变量 DSH_NODE（兼容 DSH_DESKTOP_NODE / NODE_BIN）
  3. PATH 里的 node
  4. DSH Desktop 自带的常见位置（如 %APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd）
四者都找不到时，打印明确的定位失败原因，并退化为括号配对粗检（不静默跳过校验）。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = "dsh-pet-guardian-dragon"

TEMPLATE = ROOT / "src" / "client.template.js"
ART_DATA = ROOT / "art" / "art-data.json"
OUT = ROOT / "lib" / "client.js"

NODE_ENV_VARS = ("DSH_NODE", "DSH_DESKTOP_NODE", "NODE_BIN")


def platform_node_candidates() -> list[Path]:
    """DSH Desktop 在不同机器 / 安装方式下 node 的常见位置（全部由环境变量拼出）。"""
    cands: list[Path] = []
    for env_name, parts in (
        ("APPDATA", ("dsh-desktop", "harness", ".desktop-bin", "node.cmd")),
        ("APPDATA", ("dsh-desktop", "harness", ".desktop-bin", "node.exe")),
        ("LOCALAPPDATA", ("Programs", "DSH Desktop", "resources", "node.exe")),
        ("ProgramFiles", ("DSH Desktop", "resources", "node.exe")),
    ):
        base = os.environ.get(env_name)
        if base:
            cands.append(Path(base, *parts))
    return cands


def resolve_node(explicit: str | None) -> tuple[Path | None, str]:
    """定位 node，返回 (路径 或 None, 人类可读的定位说明)。"""
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return p, f"--node 参数：{p}"
        return None, f"--node 指定的文件不存在：{p}"

    for var in NODE_ENV_VARS:
        raw = os.environ.get(var)
        if not raw:
            continue
        p = Path(raw)
        if p.is_file():
            return p, f"环境变量 {var}：{p}"
        print(f"提示：环境变量 {var} 指向的 node 不存在，已忽略：{p}")

    found = shutil.which("node")
    if found:
        return Path(found), f"PATH：{found}"

    for cand in platform_node_candidates():
        if cand.is_file():
            return cand, f"自动探测：{cand}"

    return None, (
        "未找到 node。请用 --node <路径> 指定，或设置环境变量 "
        + " / ".join(NODE_ENV_VARS)
        + "，或把 node 加入 PATH（DSH Desktop 自带的 node 通常位于 "
        + r"%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd)"
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="组装 lib/client.js（内联美术 + 官方 lazy-CJS 外壳）"
    )
    ap.add_argument(
        "--node",
        default=None,
        help="用于 `node --check` 的 node 可执行文件路径；默认按 环境变量 / PATH / 常见位置 自动探测",
    )
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if not TEMPLATE.is_file():
        print(f"模板缺失：{TEMPLATE}")
        return 1
    if not ART_DATA.is_file():
        print(f"美术数据缺失：{ART_DATA}（先跑 art/build-art.py）")
        return 1

    body = TEMPLATE.read_text(encoding="utf-8")
    art = json.loads(ART_DATA.read_text(encoding="utf-8"))

    # 只内联桌宠实际用到的素材，避免 bundle 无谓变大。
    # 资产名（kebab）→ JS 侧键名（camel），便于客户端写 ART.girlLookback。
    ART_KEYS = {
        "girl": "girl",
        "dragon": "dragon",
        "avatar": "avatar",
        "girl-lookback": "girlLookback",
        "girl-feed": "girlFeed",
        # 走路四帧（相位驱动步态循环，顺序固定 contact-A/passing-A/contact-B/passing-B）
        "girl-walk-1": "girlWalk1",
        "girl-walk-2": "girlWalk2",
        "girl-walk-3": "girlWalk3",
        "girl-walk-4": "girlWalk4",
    }
    # 注：girl-lean 已不再被客户端引用，故不内联；资产文件保留以便回退
    missing = [k for k in ART_KEYS if k not in art]
    if missing:
        print("提示：以下动作素材缺失，客户端会回退到待机立绘 ->", ", ".join(missing))
    used = {js: art[k] for k, js in ART_KEYS.items() if k in art}
    # 占位符必须**恰好出现一次**。之前模板顶部的注释里也写了这个字面量，
    # 导致 str.replace 把整份美术数据重复注入了一遍（产物凭空大一倍）。
    token = "__" + "ART__"
    n = body.count(token)
    if n != 1:
        print(f"占位符 {token} 出现 {n} 次，期望恰好 1 次")
        return 1
    body = body.replace(token, json.dumps(used, ensure_ascii=False))

    head = (
        f"/* {PKG} — 浏览器半边（由 art/build-client.py 生成，请勿手改）。\n"
        f"   手写 lazy-CJS factory：本机无 pnpm/git，官方的 clientBundle 预设\n"
        f"   不在任何已发布包里，因此不能走打包器。 */\n"
        f"window.__ModuleLoader__.load({{ id: {json.dumps(PKG)}, factory: (require) => {{\n"
        f"var module = {{ exports: {{}} }}; var exports = module.exports;\n"
    )
    tail = "\nreturn module.exports; } });\n"

    text = head + body + tail
    # 编码免疫：把非 ASCII 全部转成 \uXXXX，使产物成为纯 ASCII。
    # 本文件的非 ASCII 只出现在字符串字面量、模板字面量与注释里，
    # 三者都接受 \u 转义（注释里则只是普通文本），因此该转换语义安全。
    # 这样即使宿主以非 UTF-8 charset 提供 /plugins/<pkg>/client.js，
    # 界面中文也不会乱码。
    text = text.encode("ascii", "backslashreplace").decode("ascii")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")

    size = OUT.stat().st_size
    print(f"wrote {OUT}  {size/1024:.1f} KB")
    try:
        OUT.read_text(encoding="ascii")
        print("ascii-only: yes")
    except UnicodeDecodeError:
        print("ascii-only: NO（仍有非 ASCII 字符）")
        return 1

    # 语法校验：宿主会在激活时校验客户端产物，先自己拦一道。
    # 注意：不能用 capture_output —— 受限环境禁止程序通过管道捕获子进程输出，
    # 那会让 subprocess.run 直接抛错（而不是拿到输出）。
    node, why = resolve_node(args.node)
    if node is not None:
        print(f"node: {why}")
        r = subprocess.run([str(node), "--check", str(OUT)])
        if r.returncode != 0:
            print("node --check FAILED")
            return 1
        print("node --check OK")
    else:
        # 兜底：**不数括号** —— 产物里的字符串与注释本身就含不等量的括号，
        # 计数会把合法产物误判为失败（实测 `()` 计数不等）。改为校验外壳结构。
        print(f"警告：{why}")
        print("       跳过真正的语法校验，改用结构粗检。")
        text = OUT.read_text(encoding="utf-8")
        problems = []
        if not text.startswith(f"/* {PKG} "):
            problems.append("产物未以预期 banner 开头")
        if not text.endswith("\nreturn module.exports; } });\n"):
            problems.append("产物未以预期 footer 结尾")
        if text.count("window.__ModuleLoader__.load(") < 1:
            problems.append("未找到 window.__ModuleLoader__.load( 外壳调用（模板正文里也会出现一次，故只要求 >= 1）")
        if text.count("__ART__") != 0:
            problems.append("美术占位符未被替换")
        if problems:
            for p in problems:
                print(f"  结构粗检不通过：{p}")
            return 1
        print("结构粗检通过（未做真正的语法校验）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
