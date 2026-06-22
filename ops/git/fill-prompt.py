#!/usr/bin/env python3
"""将 architecture_doc / src_code / git_diff 填入 diff_review.md 占位符。"""

import sys


def main() -> None:
    if len(sys.argv) != 6:
        print(
            "用法: fill-prompt.py <prompt.md> <arch.txt> <src.txt> <diff.txt> <out.txt>",
            file=sys.stderr,
        )
        sys.exit(2)

    prompt_file, arch_file, src_file, diff_file, out_file = sys.argv[1:6]

    template = open(prompt_file, encoding="utf-8").read()
    architecture_doc = open(arch_file, encoding="utf-8").read()
    src_code = open(src_file, encoding="utf-8").read()
    git_diff = open(diff_file, encoding="utf-8").read()

    placeholders = [
        ("architecture_doc", "{architecture_doc}"),
        ("src_code", "{src_code}"),
        ("git_diff", "{git_diff}"),
    ]
    missing_in_template = [name for name, token in placeholders if token not in template]
    if missing_in_template:
        print(
            f"❌ prompt 模板缺少占位符: {', '.join(missing_in_template)}",
            file=sys.stderr,
        )
        sys.exit(1)

    filled = template.replace("{architecture_doc}", architecture_doc)
    filled = filled.replace("{src_code}", src_code)
    filled = filled.replace("{git_diff}", git_diff)

    open(out_file, "w", encoding="utf-8").write(filled)


if __name__ == "__main__":
    main()
