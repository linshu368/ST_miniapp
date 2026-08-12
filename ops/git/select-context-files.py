#!/usr/bin/env python3
"""对 diff 圈定的触达源码（变量块）做相关性排序 + 预算截断。

argv:
  1 numstat_file  : `git diff BASE...HEAD --numstat`（added\tdeleted\tpath）。
                    也兼容 name-only 清单（每行一个路径，churn 记为 0）。
  2 repo_root
  3 core_list_file: 固定块已含的绝对路径清单（逐行），用于去重
  4 budget_tokens : 变量块可用 token 上限（int）；<=0 则一个都不投喂

stdout（每个候选一行，KEEP 行已按投喂顺序＝优先级排列）:
  KEEP\t<tokens>\t<churn>\t<relpath>
  DROP\t<reason>\t<tokens>\t<churn>\t<relpath>   reason ∈ {budget, oversize}
stderr: 一行汇总（variable_block_tokens / budget / kept / dropped）

优先级（相关性）划分依据:
  1) churn 降序：added+deleted 改动行数越大，越是本次 diff 的核心，
     审查越依赖它的全文上下文 —— 这是「与 diff 强相关」最直接的度量。
  2) churn 相同时按文件体积升序：同等相关性下优先小文件，
     让同一预算内能多容纳几个文件（token 性价比）。
预算截断（＝大 diff 降级）:
  按优先级从高到低累加；一旦某文件加入会超预算，则该文件及其后所有
  更低优先级文件全部丢弃（reason=budget）—— 即「从相关性最小的开始砍」。
额外护栏:
  - include/exclude 正则：只收 packages/ops 下源码与配置，排除 vendor/
    测试/锁文件/类型声明/生成物，以及整包属于 ST 链路、正在被自研引擎替换的
    四个包与 ST 专用运维目录（docs/ST_remove.md §四 的删除清单）。
    这些文件被 diff 触达时仍会出现在 diff 里，只是不再额外投喂全文。
  - 单文件 token 上限（REVIEW_MAX_FILE_TOKENS，默认 30000）：超大单文件
    （多为生成物）不投全文，仅靠 diff 呈现，reason=oversize；不触发预算截断。
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from estimate_tokens import estimate_file  # noqa: E402

INCLUDE_RE = re.compile(
    r"^(packages|ops)/.*\.(ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|prisma|sql|conf|sh|css)$"
)
EXCLUDE_RE = re.compile(
    r"(^|/)(vendor|node_modules|dist|\.next)/"
    r"|pnpm-lock\.yaml|package-lock"
    r"|\.test\.|\.spec\.|__tests__/|\.d\.ts$"
    # ST 链路：整包只服务 ST、替换后整体删除，不值得占变量块预算
    r"|^packages/(bridge-protocol|st-extension|sync-engine|db-types)/"
    r"|^ops/(st-extensions|sillytavern|s6)/"
)
MAX_FILE_TOKENS = int(os.environ.get("REVIEW_MAX_FILE_TOKENS", "30000"))


def _resolve_rename(path: str) -> str:
    # numstat 重命名形态： dir/{old => new}/file 或 old => new
    if " => " in path:
        path = re.sub(r"\{[^}]*=> ([^}]*)\}", r"\1", path)
        if " => " in path:
            path = path.split(" => ")[-1]
    return path.strip()


def parse_numstat(path: str):
    rows = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) >= 3 and (parts[0].isdigit() or parts[0] == "-"):
                a, d = parts[0], parts[1]
                churn = (int(a) if a.isdigit() else 0) + (int(d) if d.isdigit() else 0)
                rel = _resolve_rename("\t".join(parts[2:]))
            else:
                rel = _resolve_rename(line.strip())
                churn = 0
            rows.append((rel, churn))
    return rows


def main():
    if len(sys.argv) < 5:
        print("usage: select-context-files.py numstat repo_root core_list budget", file=sys.stderr)
        sys.exit(2)
    numstat, repo_root, core_list_file, budget = (
        sys.argv[1],
        sys.argv[2],
        sys.argv[3],
        int(sys.argv[4]),
    )

    core = set()
    if os.path.isfile(core_list_file):
        with open(core_list_file, encoding="utf-8", errors="replace") as f:
            core = {ln.strip() for ln in f if ln.strip()}

    seen = set()
    cands = []  # [relpath, churn, tokens, size]
    for rel, churn in parse_numstat(numstat):
        if not rel or rel in seen:
            continue
        seen.add(rel)
        if not INCLUDE_RE.match(rel) or EXCLUDE_RE.search(rel):
            continue
        absp = os.path.join(repo_root, rel)
        if not os.path.isfile(absp):  # 已删除文件只在 diff 里呈现
            continue
        if absp in core:  # 固定块已含，去重
            continue
        cands.append([rel, churn, estimate_file(absp), os.path.getsize(absp)])

    # 优先级：churn 降序，再按体积升序
    cands.sort(key=lambda r: (-r[1], r[3]))

    used = 0
    cut = False
    kept = dropped = 0
    lines = []
    for rel, churn, toks, _size in cands:
        if toks > MAX_FILE_TOKENS:
            lines.append(f"DROP\toversize\t{toks}\t{churn}\t{rel}")
            dropped += 1
            continue
        if cut or used + toks > budget:
            cut = True  # 一旦触发预算截断，后续更低优先级文件一并砍掉
            lines.append(f"DROP\tbudget\t{toks}\t{churn}\t{rel}")
            dropped += 1
            continue
        used += toks
        kept += 1
        lines.append(f"KEEP\t{toks}\t{churn}\t{rel}")

    sys.stdout.write("\n".join(lines) + ("\n" if lines else ""))
    print(
        f"variable_block_tokens={used} budget={budget} kept={kept} dropped={dropped}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
