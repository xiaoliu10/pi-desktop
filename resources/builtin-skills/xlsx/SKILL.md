---
name: xlsx
description: "Excel 表格创建、编辑与分析。当用户需要创建 .xlsx/.csv 表格、修改电子表格内容/公式/样式、数据透视或统计汇总、批量处理表格数据，或提到 Excel、表格、电子表格、工作簿时使用。"
builtin: true
---

# XLSX 创建、编辑与分析

## 概述

电子表格任务三条路：**读数据**用 openpyxl/pandas；**新建或改写**用 openpyxl（保留公式、样式、多 sheet）；**分析汇总**用 pandas。禁止把日期/金额当字符串写入；公式引用必须是单元格而非硬编码值。

## 读取与分析

```python
import openpyxl
wb = openpyxl.load_workbook("book.xlsx", data_only=False)  # False=保留公式原文
ws = wb.active
for row in ws.iter_rows(values_only=True):
    print(row)
```

- `data_only=True` 读「上次计算的值」——文件若未经 Excel 打开计算过会得到 None，此时优先 data_only=False 读公式
- 大文件统计：`pandas.read_excel("book.xlsx")` 后用 groupby/pivot

## 创建工作簿（openpyxl）

```bash
python -c "import openpyxl" || pip install openpyxl
```

```python
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

wb = openpyxl.Workbook(); ws = wb.active; ws.title = "明细"
headers = ["日期", "项目", "金额"]
ws.append(headers)
for c in range(1, len(headers) + 1):
    cell = ws.cell(row=1, column=c)
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill("solid", fgColor="1D1D1F")
ws.append(["2026-10-01", "示例", 100])
ws.append(["2026-10-02", "示例二", 250])
ws["D2"] = "=SUM(C2:C3)"          # 汇总用公式，不硬编码
ws.column_dimensions["B"].width = 18
wb.save("output.xlsx")
```

## 编辑现有工作簿

```python
wb = openpyxl.load_workbook("book.xlsx")   # 默认保留公式与样式
ws = wb["Sheet1"]
ws["B2"] = "新值"
ws.insert_rows(3)
wb.save("updated.xlsx")
```

- 修改后另存新文件，避免覆盖原始数据；用户未指明时保留其他 sheet 原样
- 加数据验证/条件格式用 openpyxl.worksheet.datavalidation 与 formatting.rule

## 质量要求（交付前必查）

1. **零公式错误**：所有引用区域与数据行数一致（新增行后检查 SUM 范围）
2. 数字列右对齐、表头加粗有底色、列宽适配内容
3. 用 pandas 重读校验行列数与合计值和预期一致
