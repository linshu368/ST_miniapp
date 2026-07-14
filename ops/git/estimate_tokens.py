#!/usr/bin/env python3
"""审查上下文脚本共用的 token 估算器。

优先用 tiktoken(cl100k_base)；未安装时降级为 CJK 感知的字符启发式，
在本仓库「代码 + 中文注释」混合内容上与 tiktoken 误差约 ±10%：
    tokens ≈ (CJK 字数) * 1.0 + (非 CJK 字符数) / 4.0

CLI: python3 estimate_tokens.py <file> [<file> ...]   # 输出各文件 token 之和
     python3 estimate_tokens.py --list <listfile>     # 从清单文件逐行读路径求和
"""
import sys

_enc = None
_tried = False


def _get_enc():
    global _enc, _tried
    if not _tried:
        _tried = True
        try:
            import tiktoken

            _enc = tiktoken.get_encoding("cl100k_base")
        except Exception:
            _enc = None
    return _enc


def estimate_text(s: str) -> int:
    enc = _get_enc()
    if enc is not None:
        return len(enc.encode(s))
    cjk = sum(1 for c in s if "\u4e00" <= c <= "\u9fff")
    return int(cjk + (len(s) - cjk) / 4.0)


def estimate_file(path: str) -> int:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return estimate_text(f.read())
    except OSError:
        return 0


def _main(argv):
    paths = []
    if len(argv) >= 2 and argv[0] == "--list":
        with open(argv[1], encoding="utf-8", errors="replace") as f:
            paths = [ln.strip() for ln in f if ln.strip()]
    else:
        paths = argv
    print(sum(estimate_file(p) for p in paths))


if __name__ == "__main__":
    _main(sys.argv[1:])
