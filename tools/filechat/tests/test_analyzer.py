"""filechat 单元测试。

使用标准库 unittest 编写（pytest 兼容，可直接被 `python3 -m pytest` 发现运行）。
覆盖：空文件、纯空行、单行超长、非 UTF-8 解码失败、--top 合法性、
高频词排序稳定性、CLI 退出码。
"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import analyzer

# 让测试可以 import 同目录下的 filechat 模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import filechat  # noqa: E402


class TestCountLines(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(analyzer.count_lines(""), 0)

    def test_single_line_no_trailing_newline(self):
        self.assertEqual(analyzer.count_lines("hello"), 1)

    def test_single_line_with_trailing_newline(self):
        self.assertEqual(analyzer.count_lines("hello\n"), 1)

    def test_multiple_lines(self):
        self.assertEqual(analyzer.count_lines("a\nb\nc\n"), 3)

    def test_universal_newlines_crlf_and_cr(self):
        self.assertEqual(analyzer.count_lines("a\r\nb\rc\n"), 3)

    def test_only_blank_lines(self):
        self.assertEqual(analyzer.count_lines("\n\n\n"), 3)


class TestCountNonemptyLines(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(analyzer.count_nonempty_lines(""), 0)

    def test_all_blank(self):
        self.assertEqual(analyzer.count_nonempty_lines("\n  \n\t\n"), 0)

    def test_mixed(self):
        self.assertEqual(analyzer.count_nonempty_lines("a\n\n  \nb\n"), 2)

    def test_whitespace_only_line_is_blank(self):
        self.assertEqual(analyzer.count_nonempty_lines("   \n"), 0)


class TestCountWords(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(analyzer.count_words(""), 0)

    def test_simple(self):
        self.assertEqual(analyzer.count_words("hello world"), 2)

    def test_multiple_whitespace(self):
        self.assertEqual(analyzer.count_words("a   b\t\nc"), 3)

    def test_leading_trailing_whitespace(self):
        self.assertEqual(analyzer.count_words("  hello  world  "), 2)

    def test_case_sensitive(self):
        # Hello 与 hello 视为不同词
        self.assertEqual(analyzer.count_words("Hello hello HELLO"), 3)


class TestLongestLineLength(unittest.TestCase):
    def test_empty_returns_none(self):
        self.assertIsNone(analyzer.longest_line_length(""))

    def test_single_line(self):
        self.assertEqual(analyzer.longest_line_length("hello world"), 11)

    def test_multiple_lines(self):
        self.assertEqual(analyzer.longest_line_length("a\nlonger line here\nc"), 16)

    def test_blank_lines_included(self):
        # 空行也算行，但长度 0 不影响最大值
        self.assertEqual(analyzer.longest_line_length("\n\nabcdef\n"), 6)

    def test_trailing_newline_not_counted(self):
        # 行尾换行符不计入行内容
        self.assertEqual(analyzer.longest_line_length("abcd\n"), 4)


class TestTopWords(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(analyzer.top_words("", 5), [])

    def test_simple_ranking(self):
        text = "the hello the world hello the"
        # the=3, hello=2, world=1
        self.assertEqual(analyzer.top_words(text, 5), [("the", 3), ("hello", 2), ("world", 1)])

    def test_limit(self):
        text = "a b c d e f"
        self.assertEqual([w for w, _ in analyzer.top_words(text, 3)], ["a", "b", "c"])

    def test_limit_exceeds_vocab(self):
        text = "a b"
        self.assertEqual([w for w, _ in analyzer.top_words(text, 10)], ["a", "b"])

    def test_tie_breaks_lexicographic(self):
        # 次数相同按字典序升序
        text = "b a c b a"
        # b=2, a=2, c=1 -> 排序后 a, b（次数相同，字典序 a < b）
        self.assertEqual(analyzer.top_words(text, 5), [("a", 2), ("b", 2), ("c", 1)])

    def test_case_sensitive(self):
        text = "Hello hello"
        self.assertEqual(analyzer.top_words(text, 5), [("Hello", 1), ("hello", 1)])

    def test_n_less_than_one(self):
        self.assertEqual(analyzer.top_words("a b c", 0), [])
        self.assertEqual(analyzer.top_words("a b c", -1), [])


class TestCliEndToEnd(unittest.TestCase):
    """CLI 端到端测试：退出码、stdout 报告、错误处理。"""

    SCRIPT = Path(os.path.abspath(__file__)).parent.parent / "filechat.py"

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(self.SCRIPT), *args],
            capture_output=True,
            text=True,
        )

    def _write_temp(self, content: str, encoding: str = "utf-8") -> str:
        fd, path = tempfile.mkstemp(suffix=".txt")
        os.close(fd)
        with open(path, "w", encoding=encoding) as fh:
            fh.write(content)
        return path

    def test_success_report_format(self):
        path = self._write_temp("hello world\nhello\n")
        try:
            result = self._run(path)
            self.assertEqual(result.returncode, 0)
            out = result.stdout
            self.assertIn("文件:", out)
            self.assertIn("总行数: 2", out)
            self.assertIn("非空行数: 2", out)
            self.assertIn("单词总数: 3", out)
            self.assertIn("最长行长度: 11", out)
            self.assertIn("Top 5 高频词:", out)
            self.assertIn("hello", out)
            self.assertIn("world", out)
        finally:
            os.remove(path)

    def test_empty_file(self):
        path = self._write_temp("")
        try:
            result = self._run(path)
            self.assertEqual(result.returncode, 0)
            self.assertIn("总行数: 0", result.stdout)
            self.assertIn("非空行数: 0", result.stdout)
            self.assertIn("单词总数: 0", result.stdout)
            self.assertIn("最长行长度: N/A", result.stdout)
        finally:
            os.remove(path)

    def test_missing_file_exit_code_1(self):
        result = self._run("/nonexistent/path/does-not-exist.txt")
        self.assertEqual(result.returncode, 1)
        self.assertIn("文件不存在", result.stderr)

    def test_non_utf8_decode_failure(self):
        path = self._write_temp("\xff\xfe\x00hello", encoding="latin-1")
        try:
            result = self._run(path)  # 默认 utf-8
            self.assertEqual(result.returncode, 1)
            self.assertIn("无法以 utf-8 编码解码", result.stderr)
        finally:
            os.remove(path)

    def test_non_utf8_with_encoding_override(self):
        path = self._write_temp("héllo wörld\n", encoding="latin-1")
        try:
            result = self._run(path, "--encoding", "latin-1")
            self.assertEqual(result.returncode, 0)
            self.assertIn("单词总数: 2", result.stdout)
        finally:
            os.remove(path)

    def test_top_zero_errors(self):
        path = self._write_temp("hello")
        try:
            result = self._run(path, "--top", "0")
            # argparse 参数错误退出码 2
            self.assertEqual(result.returncode, 2)
        finally:
            os.remove(path)

    def test_top_negative_errors(self):
        path = self._write_temp("hello")
        try:
            result = self._run(path, "--top", "-3")
            self.assertNotEqual(result.returncode, 0)
        finally:
            os.remove(path)

    def test_top_option(self):
        path = self._write_temp("a b c d e f")
        try:
            result = self._run(path, "--top", "2")
            self.assertEqual(result.returncode, 0)
            self.assertIn("Top 2 高频词:", result.stdout)
            self.assertNotIn("c ", result.stdout)
        finally:
            os.remove(path)

    def test_very_long_line(self):
        path = self._write_temp("x" * 10000 + "\nshort\n")
        try:
            result = self._run(path)
            self.assertEqual(result.returncode, 0)
            self.assertIn("最长行长度: 10000", result.stdout)
        finally:
            os.remove(path)


if __name__ == "__main__":
    unittest.main()