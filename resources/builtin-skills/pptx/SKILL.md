---
name: pptx
description: "PPT/演示文稿制作、编辑与分析。当用户需要创建 .pptx 演示文稿、修改幻灯片内容或版式、提取演示文稿文字、添加演讲者备注，或提到 PPT、幻灯片、演示文稿、slides、deck 时使用。"
builtin: true
---

# PPTX 创建、编辑与分析

## 概述

.pptx 本质是包含 XML 的 ZIP 包。按任务选择工作流：**读取文字**用 markitdown 提取；**新建演示文稿**用 python-pptx 从零构建；**修改现有文件**用 python-pptx 打开原文件就地编辑（保留版式）。

## 读取与分析

```bash
# 文字提取（首选，输出 markdown）
python -m markitdown path/to/deck.pptx
# 无 markitdown 时：pip install markitdown
```

需要批注、演讲者备注、版式结构等细节时，解包读 XML：

```bash
mkdir /tmp/deck && cd /tmp/deck && unzip -o -q /path/to/deck.pptx
# 幻灯片在 ppt/slides/slideN.xml；备注在 ppt/notesSlides/
```

## 创建演示文稿（python-pptx）

```bash
python -c "import pptx" || pip install python-pptx
```

从空白演示文稿构建（推荐套路：先定版式，再逐页填充）：

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)  # 16:9

# 标题页
slide = prs.slides.add_slide(prs.slide_layouts[0])
slide.shapes.title.text = "主题"
slide.placeholders[1].text = "副标题 / 日期"

# 内容页（标题 + 正文要点）
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = "章节"
body = slide.placeholders[1].text_frame
body.text = "第一个要点"
for point in ("第二个要点", "第三个要点"):
    p = body.add_paragraph(); p.text = point; p.level = 1

prs.save("output.pptx")
```

样式要点：
- 字号统一：标题 32-40pt，正文 18-24pt；一页要点不超过 5 条
- 强调色：`p.font.color.rgb = RGBColor(0x1d, 0x1d, 0x1f)`；避免默认蓝
- 大段文字放不下时**拆页**，不要缩字号硬塞

## 编辑现有演示文稿

```python
from pptx import Presentation
prs = Presentation("existing.pptx")
for slide in prs.slides:
    for shape in slide.shapes:
        if not shape.has_text_frame: continue
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                if "旧文案" in run.text:
                    run.text = run.text.replace("旧文案", "新文案")
prs.save("updated.pptx")
```

- 直接在原对象上改再另存，版式/母版/主题自动保留；**不要**重建文件再拼
- 演讲者备注：`slide.notes_slide.notes_text_frame.text = "备注内容"`

## 交付前检查

1. 用 markitdown 重新提取，确认无占位文本（Lorem ipsum、"单击此处"）
2. 检查页数与用户要求一致；标题页/目录/结尾页齐全
3. 中文演示确认字体回退正常（正文可用「微软雅黑 / PingFang SC」）
