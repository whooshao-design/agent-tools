---
name: convert-epub-to-markdown
description: 将本地 EPUB 电子书转换为适合阅读、检索和文档问答的 Markdown，保留原件、章节和图片并校验正文。Use when 用户要求“EPUB 转 MD”“把电子书提供给 ChatGPT 读取”；不用于 PDF 转换、OCR 或 DRM 解密。
metadata:
  version: 1.0.1
---

# EPUB 转 Markdown

## 定位

把 EPUB 中可提取的文字转换成可追溯原文的 Markdown。只做格式转换，不摘要、不改写，不补写原文没有的内容。

**MCP 优先、脚本兜底**：小文件可优先使用已可用的 MarkItDown MCP；使用本地 `file:` URI，先确认工具在本机读取。MCP 输出必须完整且能验证。大型合订本、输出会截断、需要分卷或保留本地图片时，直接使用下述脚本，避免将整本书塞进工具返回内容。当前脚本不调用模型或上传文档。

## 输出决策

- 原 EPUB 默认始终保留，转换前后比较 SHA-256；不覆盖已有输出目录。
- 用户指定全文或分卷时按其要求执行。未指定时默认 `auto`：短书生成 `content.md`，长书按目录和 EPUB 页面边界生成多个 Markdown。
- **默认只保留一套正文**。不能因为用户说“转成 MD”就同时生成全文版、分卷版、TXT 等重复副本。两种版本都需要时才生成，并说明各自用途。
- 大型文档问答优先分卷，保留日期、章节和问答层级。40 万个非空白字符是脚本的分卷目标，不是 ChatGPT 文件限制，也不是 token 数。
- 默认输出到原文件旁的 `<原文件名>-md/`，包含正文、`README.md` 索引、`images/`（有图片时）和 `conversion-report.json`。README 是转换产物的目录，不是重复正文。
- 不因本次格式转换自动删除历史副本或提交、推送、上传文件；按当前任务已有授权执行。

## 执行

先发现目标文件、读取适用的 AGENTS.md，检查已有输出。文件名有空格、中文或变音符号时完整引用路径。

脚本和依赖位于：

- `/home/joney/projects/ai/agent-tools/skills/common/convert-epub-to-markdown/scripts/convert_epub.py`
- `/home/joney/projects/ai/agent-tools/skills/common/convert-epub-to-markdown/scripts/requirements.txt`

优先复用可用的隔离 Python 环境；缺依赖时创建临时环境，不改全局 Python：

```bash
python3 -m venv /tmp/epub-md-venv
/tmp/epub-md-venv/bin/python -m pip install --no-cache-dir -r /home/joney/projects/ai/agent-tools/skills/common/convert-epub-to-markdown/scripts/requirements.txt
```

先只读检查；终端只显示计数和必要的元数据，不打印全部 OPF、NCX 或正文：

```bash
/tmp/epub-md-venv/bin/python /home/joney/projects/ai/agent-tools/skills/common/convert-epub-to-markdown/scripts/convert_epub.py '/path/to/book.epub' --inspect
```

转换并校验：

```bash
/tmp/epub-md-venv/bin/python /home/joney/projects/ai/agent-tools/skills/common/convert-epub-to-markdown/scripts/convert_epub.py '/path/to/book.epub'
```

需要明确选择时加 `--layout single` 或 `--layout split`；自定义目录用 `--output-dir '/path/to/new-output'`。批量处理时逐本执行，结果与原件分别对应。

## 转换约束与已验证的经验

- 从 `META-INF/container.xml` 找到根 OPF，再按根 OPF 的 **spine 阅读顺序**处理。合订本内部可能有上千份子 OPF，不能将 ZIP 文件名排序当阅读顺序，也不要全文打印所有元数据。
- 优先用原 NCX 或 EPUB 3 导航识别目录。源标题重复时按原样保留，以分卷序号区分；不能凭猜测修正年份。
- 分卷不能截断段落。脚本在 EPUB 页面边界拆分；若承接同一讲，在卷首注明章节。单页超过目标大小时会报告，需进一步按标题或段落拆分后重新核对，不能声称满足硬性大小限制。
- 使用 `markdownify` 时，`heading_style='ATX'`、`escape_misc=True` 能保留标题并避免正文符号被误识别为 Markdown。**不要对已经转义的 `&`、`<`、`>` 再次转义**。
- 中文标点旁的粗体标记可能在回读时变成字面量 `**`。先验证；仅发生这种差异时，可去掉粗体排版再验证，保留全部文字，并记录排版简化。不能通过删除原文中的星号来“修复”。
- 图片以原始字节复制并使用相对链接；不声称图片文字已转换。单独上传 MD 不会同时上传图片，相关问题需另附原图。对扫描页、内嵌 SVG、加密正文等不适用输入，说明边界后选择对应工具，不绕过校验继续交付。
- EPUB 内部链接需要转换为输出文件及锚点链接。引用的正文不在 spine 或目标不存在时必须报告并处理；不能静默丢掉脚注或生成损坏链接。

## 验证与交付

脚本先写临时目录，以下检查通过才生成最终目录：

1. 对每个正文页面将 Markdown 重新解析为 HTML，去掉空白后与 EPUB 原文逐字比较；比较失败时报告页面与差异位置，不输出大段正文。
2. 分卷正文按顺序重新拼接，与转换后的全部页面一致；封面、说明、附录和正文按 spine 保留。
3. 校验内部链接、图片链接及图片字节，确认原 EPUB SHA-256 未变。

检查报告里的警告：spine 外的 HTML、无文字页面、超大单页、外链图片和排版简化均需解释，不能把“spine 内文字一致”扩大成“图片及所有附件内容均已转成文字”。另抽查首尾、表格和分卷承接处的实际可读性。

最终简短报告原件保留、输出入口、正文/分卷数量、验证结果和实际限制。文档问答可建议用户先上传目录及相关分卷，要求答案注明章节、日期（若有）和短原文依据；找不到依据就明确说明，区分原文与推断。
