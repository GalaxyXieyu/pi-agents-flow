#!/usr/bin/env python3
"""filechat — 文本文件统计工具。

读取一个文本文件，按行拆分并统计：总行数、非空行数、单词总数、
最长行长度、Top N 高频词，输出易读的文本报告。

仅使用 Python 标准库，无第三方依赖。
"""

import argparse
import sys
from typing import List, Optional, Tuple

from analyzer import (
    count_lines,
    count_nonempty_lines,
    count_words,
    longest_line_length,
    top_words,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="filechat",
        description="读取文本文件并输出行数、单词数、最长行长度与高频词统计报告。",
    )
    parser.add_argument("path", help="要分析的文本文件路径")
    parser.add_argument(
        "--top",
        type=int,
        default=5,
        metavar="N",
        help="高频词条数，默认 5，取值范围 1 ≤ N",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        metavar="ENC",
        help="指定读取编码，默认 utf-8",
    )
    return parser


def read_file(path: str, encoding: str) -> str:
    with open(path, "r", encoding=encoding) as fh:
        return fh.read()


def format_report(path: str, text: str, top_n: int) -> str:
    total = count_lines(text)
    nonempty = count_nonempty_lines(text)
    words = count_words(text)
    longest = longest_line_length(text)

    lines: List[str] = []
    lines.append(f"文件: {path}")
    lines.append(f"总行数: {total}")
    lines.append(f"非空行数: {nonempty}")
    lines.append(f"单词总数: {words}")

    if longest is None:
        lines.append("最长行长度: N/A")
    else:
        lines.append(f"最长行长度: {longest}")

    lines.append("")
    lines.append(f"Top {top_n} 高频词:")
    ranked = top_words(text, top_n)
    if not ranked:
        lines.append(" (无)")
    else:
        width = max(len(word) for word, _ in ranked)
        for idx, (word, count) in enumerate(ranked, start=1):
            lines.append(f" {idx}. {word:<{width}}  ({count} 次)")
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse 对 --top 非法会以退出码 2 退出
        return int(exc.code) if exc.code is not None else 2

    if args.top < 1:
        parser.error("--top 必须为正整数（1 ≤ N）")
        return 2

    try:
        text = read_file(args.path, args.encoding)
    except FileNotFoundError:
        print(f"filechat: 错误：文件不存在：{args.path}", file=sys.stderr)
        return 1
    except IsADirectoryError:
        print(f"filechat: 错误：路径是目录：{args.path}", file=sys.stderr)
        return 1
    except PermissionError:
        print(f"filechat: 错误：无法读取文件（权限不足）：{args.path}", file=sys.stderr)
        return 1
    except UnicodeDecodeError:
        print(
            f"filechat: 错误：无法以 {args.encoding} 编码解码文件（尝试使用 --encoding 覆盖）：{args.path}",
            file=sys.stderr,
        )
        return 1
    except OSError as exc:
        print(f"filechat: 错误：{exc}", file=sys.stderr)
        return 1

    print(format_report(args.path, text, args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())