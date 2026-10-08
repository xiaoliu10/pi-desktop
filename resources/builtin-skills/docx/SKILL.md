---
name: docx
description: "Word 文档创建、编辑与分析。当用户需要创建 .docx 文档、修改 Word 文件内容或格式、提取文档文字、处理修订/批注，或提到 Word、文档、doc 文件时使用。"
builtin: true
---

# DOCX 创建、编辑与分析

## 概述

.docx 是 ZIP+XML。按任务选择：**提取文字**用 markitdown；**新建文档**用 python-docx；**修改现有文档**用 python-docx 打开原文件就地编辑（保留样式与结构）。

## 读取与分析

```bash
python -m markitdown path/to/doc.docx   # 输出 markdown（需 pip install markitdown）
# 需要批注/修订等细节：unzip -o -q doc.docx -d /tmp/doc 后读 word/document.xml、word/comments.xml
```

## 创建文档（python-docx）

```bash
python -c "import docx" || pip install python-docx
```

```python
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
# 全局正文字体（中文回退）
style = doc.styles["Normal"]
style.font.name = "Calibri"; style.font.size = Pt(11)
style.element.rPr.rFonts.set("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia", "微软雅黑")

doc.add_heading("文档标题", level=0)
doc.add_heading("第一章", level=1)
doc.add_paragraph("正文段落。")
p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run("居中强调文字"); run.bold = True

doc.add_table(rows=2, cols=3, style="Table Grid")  # 带边框表格
doc.save("output.docx")
```

- 标题层级用 `add_heading(level=n)`，不要手动加粗模拟
- 页眉页脚：`doc.sections[0].header.paragraphs[0].text = "..."`
- 图片：`doc.add_picture("img.png", width=Cm(12))`

## 编辑现有文档

```python
from docx import Document
doc = Document("existing.docx")
for para in doc.paragraphs:
    for run in para.runs:
        if "旧文案" in run.text:
            run.text = run.text.replace("旧文案", "新文案")   # 保留 run 级样式
doc.save("updated.docx")
```

- 逐 run 替换（不要整段重写 `para.text`，会丢样式）
- 表格遍历：`for row in doc.tables[0].rows: for cell in row.cells: ...`

## 交付前检查

1. markitdown 重新提取，确认替换/新增内容就位、无占位文本
2. 中文文档检查东亚字体已设置（否则中文渲染为衬线默认体）
3. 用户要求字数/章节结构的，逐项核对
