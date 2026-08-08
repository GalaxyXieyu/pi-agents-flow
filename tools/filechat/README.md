# filechat

一个独立的 Python 命令行工具，读取文本文件并输出统计报告：总行数、非空行数、单词总数、最长行长度、Top N 高频词。

仅使用 Python 标准库，**零第三方依赖**。

## 安装

无需安装。需要 Python 3.6+。

```bash
git clone <your-repo>
cd tools/filechat
```

## 用法

```bash
python3 filechat.py <文件路径>
python3 filechat.py [选项] <文件路径>
```

### 选项

| 选项 | 说明 |
|---|---|
| `--top N` | 高频词条数，默认 `5`，取值范围 `1 ≤ N` |
| `--encoding ENC` | 指定读取编码，默认 `utf-8` |
| `-h, --help` | 打印帮助并退出 |

### 示例

```bash
$ python3 filechat.py example.txt
文件: example.txt
总行数: 12
非空行数: 10
单词总数: 87
最长行长度: 45

Top 5 高频词:
 1. the      (12 次)
 2. hello    (8 次)
 3. world    (5 次)
 4. python   (3 次)
 5. code     (2 次)
```

## 边界情况

- **空文件**：退出码 `0`，最长行长度显示 `N/A`，无高频词。
- **纯空行文件**：总行数 ≥ 1，非空行数 `0`，单词总数 `0`。
- **非 UTF-8 文件**：默认退出码 `1`；可用 `--encoding` 指定编码覆盖。
- **单行超长**：不作为错误，按实际字符数统计。
- **文件不存在 / 不可读**：退出码 `1`，错误信息输出到 `stderr`。
- **`--top 0` 或负数**：参数错误，退出码 `2`。

## 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 分析成功 |
| `1` | 文件不存在 / 不可读 / 解码失败 |
| `2` | 参数错误 |

## 测试

```bash
cd tools/filechat
python3 -m pytest          # 若已安装 pytest
python3 -m unittest discover -s tests -v   # 或使用标准库 unittest
```

## 文件结构

```
tools/filechat/
├── filechat.py        # 入口脚本（argparse + 主流程）
├── analyzer.py        # 统计逻辑（纯函数，便于测试）
├── tests/
│   └── test_analyzer.py
└── README.md
```