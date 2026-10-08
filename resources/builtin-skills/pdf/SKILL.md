---
name: pdf
description: "PDF 处理工具集：提取文字与表格、创建 PDF、合并/拆分文档、填写表单。当用户需要处理 .pdf 文件（读取、生成、合并、拆分、表单、转换）时使用。"
builtin: true
---

# PDF 处理指南

## 概述

按操作选择库：**提取文字/表格**用 pdfplumber；**合并/拆分/加密**用 pypdf；**从数据生成 PDF**用 reportlab；**扫描件 OCR** 提示用户质量限制后用 pytesseract。处理前先看页数与文本层是否存在。

## 提取文字与表格

```bash
python -c "import pdfplumber" || pip install pdfplumber pypdf
```

```python
import pdfplumber
with pdfplumber.open("doc.pdf") as pdf:
    print(len(pdf.pages), "页")
    for page in pdf.pages:
        print(page.extract_text())
        for table in page.extract_tables():
            for row in table: print(row)
```

- `extract_text()` 为空 → 扫描件无文本层，走 OCR（pytesseract，中文加 `lang="chi_sim"`）并告知识别率限制
- 表格跨页时逐页提取后拼接，注意表头去重

## 合并与拆分（pypdf）

```python
from pypdf import PdfWriter, PdfReader

# 合并
w = PdfWriter()
for f in ("a.pdf", "b.pdf"):
    for page in PdfReader(f).pages: w.add_page(page)
with open("merged.pdf", "wb") as fh: w.write(fh)

# 拆分：第 3-5 页抽出
r = PdfReader("src.pdf")
w = PdfWriter()
for i in range(2, 5): w.add_page(r.pages[i])
with open("part.pdf", "wb") as fh: w.write(fh)
```

## 生成 PDF（reportlab）

```python
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# 中文必须注册 TTF 字体，否则中文变黑块
pdfmetrics.registerFont(TTFont("PingFang", "/System/Library/Fonts/PingFang.ttc"))

from reportlab.pdfgen import canvas
c = canvas.Canvas("output.pdf", pagesize=A4)
c.setFont("PingFang", 14)
c.drawString(72, 780, "中文内容")
c.showPage(); c.save()
```

- 结构化长文档（多级标题+表格）优先用 platypus（SimpleDocTemplate + Paragraph + Table），自动分页
- 拿不准字体路径时 `fc-list | grep -i pingfang` 查找

## 表单填写

```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("form.pdf")
fields = r.get_fields()          # 先列出字段名
w = PdfWriter(clone_from="form.pdf")
w.update_page_form_field_values(w.pages[0], {"姓名": "张三", "Date": "2026-10-08"})
with open("filled.pdf", "wb") as fh: w.write(fh)
```

## 交付前检查

1. 生成类：重新打开提取文本核对内容完整、中文无乱码
2. 合并/拆分类：核对页数 = 预期
3. 大文件（>50 页）先报告页数与预计耗时，避免无提示的长阻塞
