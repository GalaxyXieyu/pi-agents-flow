"""filechat 统计逻辑 — 纯函数，便于单元测试。

仅使用 Python 标准库，无第三方依赖。
"""

from typing import List, Optional, Tuple


def count_lines(text: str) -> int:
    """总行数。

    使用通用换行符语义（统一处理 \\n、\\r\\n、\\r）。
    空文件返回 0。以换行符结尾的文本不额外增加空行计数。
    """
    if not text:
        return 0
    # splitlines 统一处理 \n、\r\n、\r，且不保留行尾换行符。
    return len(text.splitlines())


def count_nonempty_lines(text: str) -> int:
    """非空行数：去掉首尾空白后长度不为 0 的行数。"""
    if not text:
        return 0
    return sum(1 for line in text.splitlines() if line.strip() != "")


def count_words(text: str) -> int:
    """单词总数：按空白字符（str.split 语义）切分的非空 token 数。"""
    if not text:
        return 0
    return len(text.split())


def longest_line_length(text: str) -> Optional[int]:
    """最长行长度（字符数）。

    返回所有行去掉换行符后的字符数最大值；空文件返回 None。
    """
    if not text:
        return None
    return max(len(line) for line in text.splitlines())


def top_words(text: str, n: int) -> List[Tuple[str, int]]:
    """Top-n 高频词，返回 (词, 次数) 列表。

    排序规则固定为「次数降序、字典序升序」以保证可复现。
    若词种不足 n，按实际词种数输出。
    大小写不折叠：Hello 与 hello 视为不同词。
    """
    if n < 1:
        return []
    counts: dict = {}
    for word in text.split():
        counts[word] = counts.get(word, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return ranked[:n]