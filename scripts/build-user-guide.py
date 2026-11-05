from __future__ import annotations

import argparse
import re
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor


REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "docs" / "USER_GUIDE.md"
OUTPUT = REPO / "docs" / "个人拉片工作台使用说明.docx"

BODY_FONT = "Microsoft YaHei"
MONO_FONT = "Cascadia Mono"
BLACK = RGBColor(0, 0, 0)
WHITE = RGBColor(255, 255, 255)
HEADER_FILL = "1F4E78"
ALT_FILL = "EAF2F8"
BORDER = "D9D9D9"


def set_cell_shading(cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_border(cell, color: str = BORDER, size: str = "4") -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = tc_pr.first_child_found_in("w:tcBorders")
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = f"w:{edge}"
        node = borders.find(qn(tag))
        if node is None:
            node = OxmlElement(tag)
            borders.append(node)
        node.set(qn("w:val"), "single")
        node.set(qn("w:sz"), size)
        node.set(qn("w:space"), "0")
        node.set(qn("w:color"), color)


def set_cell_margins(cell, top: int = 90, start: int = 110, bottom: int = 90, end: int = 110) -> None:
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for key, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{key}"))
        if node is None:
            node = OxmlElement(f"w:{key}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_repeat_table_header(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def prevent_row_split(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = OxmlElement("w:cantSplit")
    tr_pr.append(cant_split)


def set_run_font(run, name: str = BODY_FONT, size: float | None = None, bold: bool | None = None) -> None:
    run.font.name = name
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    run.font.color.rgb = BLACK


def clear_cell(cell) -> None:
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.15
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER


def remove_paragraph_borders(paragraph) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    for border in list(p_pr.findall(qn("w:pBdr"))):
        p_pr.remove(border)


INLINE_RE = re.compile(r"(\*\*.*?\*\*|`.*?`|\[[^\]]+\]\([^)]+\))")


def add_inline(paragraph, text: str, *, size: float = 10.5, color: RGBColor = BLACK) -> None:
    for token in INLINE_RE.split(text):
        if not token:
            continue
        if token.startswith("**") and token.endswith("**"):
            run = paragraph.add_run(token[2:-2])
            set_run_font(run, size=size, bold=True)
        elif token.startswith("`") and token.endswith("`"):
            run = paragraph.add_run(token[1:-1])
            set_run_font(run, name=MONO_FONT, size=max(8.8, size - 0.8))
            run.font.color.rgb = RGBColor(45, 55, 72)
        elif token.startswith("[") and "](" in token:
            label = token[1:token.index("]")]
            run = paragraph.add_run(label)
            set_run_font(run, size=size)
        else:
            run = paragraph.add_run(token)
            set_run_font(run, size=size)
        run.font.color.rgb = color


def add_page_number(paragraph) -> None:
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = paragraph.add_run("第 ")
    set_run_font(run, size=9)
    fld_char1 = OxmlElement("w:fldChar")
    fld_char1.set(qn("w:fldCharType"), "begin")
    instr_text = OxmlElement("w:instrText")
    instr_text.set(qn("xml:space"), "preserve")
    instr_text.text = "PAGE"
    fld_char2 = OxmlElement("w:fldChar")
    fld_char2.set(qn("w:fldCharType"), "end")
    run._r.append(fld_char1)
    run._r.append(instr_text)
    run._r.append(fld_char2)
    tail = paragraph.add_run(" 页")
    set_run_font(tail, size=9)


def setup_styles(doc: Document) -> None:
    normal = doc.styles["Normal"]
    normal.font.name = BODY_FONT
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = BLACK
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.35

    specs = {
        "Title": (25, 18, 10),
        "Subtitle": (14, 0, 14),
        "Heading 1": (16, 18, 8),
        "Heading 2": (12.5, 12, 6),
        "Heading 3": (11, 9, 4),
    }
    for name, (size, before, after) in specs.items():
        style = doc.styles[name]
        style.font.name = BODY_FONT
        style._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
        style.font.size = Pt(size)
        style.font.bold = name != "Subtitle"
        style.font.color.rgb = BLACK
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = name.startswith("Heading")
        style_p_pr = style.element.get_or_add_pPr()
        for border in list(style_p_pr.findall(qn("w:pBdr"))):
            style_p_pr.remove(border)

    for name in ("List Bullet", "List Number"):
        style = doc.styles[name]
        style.font.name = BODY_FONT
        style._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
        style.font.size = Pt(10.5)
        style.font.color.rgb = BLACK
        style.paragraph_format.space_after = Pt(3)
        style.paragraph_format.line_spacing = 1.25


def add_table(doc: Document, rows: list[list[str]]) -> None:
    if not rows:
        return
    cols = max(len(row) for row in rows)
    normalized = [row + [""] * (cols - len(row)) for row in rows]
    table = doc.add_table(rows=len(normalized), cols=cols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True
    table.allow_autofit = True
    widths = [Cm(16.4 / cols)] * cols
    if cols == 2:
        widths = [Cm(4.1), Cm(12.3)]
    elif cols == 3:
        widths = [Cm(3.3), Cm(6.2), Cm(6.9)]
    for row_index, values in enumerate(normalized):
        row = table.rows[row_index]
        prevent_row_split(row)
        if row_index == 0:
            set_repeat_table_header(row)
        for col_index, value in enumerate(values):
            cell = row.cells[col_index]
            cell.width = widths[col_index]
            set_cell_shading(cell, HEADER_FILL if row_index == 0 else (ALT_FILL if row_index % 2 == 0 else "FFFFFF"))
            set_cell_border(cell)
            set_cell_margins(cell)
            clear_cell(cell)
            p = cell.paragraphs[0]
            add_inline(
                p,
                value,
                size=9.2 if row_index else 9.4,
                color=WHITE if row_index == 0 else BLACK,
            )
    after = doc.add_paragraph()
    after.paragraph_format.space_after = Pt(4)


def add_code_block(doc: Document, lines: list[str]) -> None:
    for index, line in enumerate(lines):
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.45)
        p.paragraph_format.right_indent = Cm(0.35)
        p.paragraph_format.space_before = Pt(3 if index == 0 else 0)
        p.paragraph_format.space_after = Pt(3 if index == len(lines) - 1 else 0)
        p.paragraph_format.line_spacing = 1.05
        p.paragraph_format.keep_with_next = index < len(lines) - 1
        run = p.add_run(line or " ")
        set_run_font(run, name=MONO_FONT, size=9.1)
        run.font.color.rgb = RGBColor(38, 50, 66)


def parse_table(lines: list[str], start: int) -> tuple[list[list[str]], int]:
    raw: list[str] = []
    i = start
    while i < len(lines) and lines[i].strip().startswith("|"):
        raw.append(lines[i].strip())
        i += 1
    rows = []
    for row in raw:
        cells = [part.strip() for part in row.strip("|").split("|")]
        if all(re.fullmatch(r":?-{3,}:?", part) for part in cells):
            continue
        rows.append(cells)
    return rows, i


def build(source: Path = SOURCE, output: Path = OUTPUT) -> None:
    md_lines = source.read_text(encoding="utf-8").splitlines()
    doc = Document()
    setup_styles(doc)
    section = doc.sections[0]
    section.orientation = WD_ORIENT.PORTRAIT
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(1.9)
    section.left_margin = Cm(2.15)
    section.right_margin = Cm(2.15)
    section.header_distance = Cm(0.8)
    section.footer_distance = Cm(0.8)

    header = section.header.paragraphs[0]
    header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    header_run = header.add_run("PERSONAL FILM LAB  |  使用与开发说明")
    set_run_font(header_run, name="Aptos", size=8.5)
    header_run.font.color.rgb = RGBColor(85, 85, 85)
    add_page_number(section.footer.paragraphs[0])

    p = doc.add_paragraph(style="Title")
    p.paragraph_format.space_before = Pt(74)
    remove_paragraph_borders(p)
    run = p.add_run("个人拉片工作台使用与开发说明")
    set_run_font(run, size=25, bold=True)

    subtitle = doc.add_paragraph(style="Subtitle")
    subtitle.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = subtitle.add_run("版本 0.1.9")
    set_run_font(run, size=14, bold=False)

    intro = doc.add_paragraph()
    intro.paragraph_format.space_before = Pt(16)
    intro.paragraph_format.space_after = Pt(18)
    intro.paragraph_format.line_spacing = 1.45
    add_inline(
        intro,
        "本手册说明个人拉片工作台的安装、日常使用、全部已实现功能、数据保护和二次开发入口。"
        "软件面向 Windows 10/11，支持本地镜头检测、逐镜标注、静帧分析、学习统计和 PDF/Word 分镜本导出。",
        size=11,
    )

    add_table(
        doc,
        [
            ["项目", "信息"],
            ["软件", "个人拉片工作台 Personal Film Lab"],
            ["当前版本", "0.1.9"],
            ["支持平台", "Windows 10 / 11 x64"],
            ["源码许可", "MIT License"],
            ["代码仓库", "github.com/YGSWGJR/personal-film-lab"],
        ],
    )
    doc.add_page_break()

    p = doc.add_paragraph(style="Heading 1")
    p.add_run("阅读指南")
    intro = doc.add_paragraph()
    add_inline(
        intro,
        "第一次使用可从“安装准备”和“快速流程”开始。需要查询按键时直接看“快捷键”；"
        "需要迁移项目时看“保存项目与恢复”；需要参与开发时看文末“二次开发快速入口”。"
        "完整功能清单同时保存在仓库 docs/FEATURES.md。",
    )

    parsed_any = False
    i = 0
    while i < len(md_lines):
        line = md_lines[i]
        stripped = line.strip()
        if line.startswith("# "):
            i += 1
            continue
        if i < 4 and (
            stripped.startswith("适用版本")
            or stripped.startswith("系统：")
            or not stripped
        ):
            i += 1
            continue
        if line.startswith("## "):
            p = doc.add_paragraph(style="Heading 1")
            p.add_run(line[3:].strip())
            parsed_any = True
            i += 1
            continue
        if line.startswith("### "):
            p = doc.add_paragraph(style="Heading 2")
            p.add_run(line[4:].strip())
            parsed_any = True
            i += 1
            continue
        if line.startswith("#### "):
            p = doc.add_paragraph(style="Heading 3")
            p.add_run(line[5:].strip())
            i += 1
            continue
        if stripped.startswith("```"):
            code: list[str] = []
            i += 1
            while i < len(md_lines) and not md_lines[i].strip().startswith("```"):
                code.append(md_lines[i])
                i += 1
            add_code_block(doc, code)
            i += 1
            continue
        if stripped.startswith("|"):
            rows, i = parse_table(md_lines, i)
            add_table(doc, rows)
            continue
        if re.match(r"^- ", line):
            p = doc.add_paragraph(style="List Bullet")
            add_inline(p, line[2:].strip())
            i += 1
            continue
        if re.match(r"^\d+\. ", line):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.55)
            p.paragraph_format.first_line_indent = Cm(-0.35)
            p.paragraph_format.space_after = Pt(3)
            add_inline(p, line.strip())
            i += 1
            continue
        if stripped:
            paragraph_lines = [stripped]
            i += 1
            while i < len(md_lines):
                nxt = md_lines[i]
                ns = nxt.strip()
                if not ns or ns.startswith(("#", "|", "```")) or re.match(r"^- ", nxt) or re.match(r"^\d+\. ", nxt):
                    break
                paragraph_lines.append(ns)
                i += 1
            p = doc.add_paragraph()
            p.paragraph_format.line_spacing = 1.35
            add_inline(p, " ".join(paragraph_lines))
            continue
        i += 1

    p = doc.add_paragraph(style="Heading 1")
    p.add_run("功能状态总览")
    add_table(
        doc,
        [
            ["类别", "已实现能力"],
            ["输入与项目", "本地视频导入、元信息探测、后台代理、三档代理、哈希缓存、跨目录项目扫描与迁移"],
            ["播放与时间线", "libmpv 播放、精确 seek、逐帧、四档倍速、音量、原生层级、V2/V1/A1、横纵缩放、区域导航、trim 和锁定"],
            ["镜头检测", "本地 Qwen3-VL 8B、OpenCV 备用、后台/取消/重试、预览后应用、锁定镜头保护、中文路径"],
            ["标注", "六类标签、自定义标签与分类、术语库、台词、备注、镜头笔记、入点/出点"],
            ["静帧", "当前帧和指定时码截图、时间元数据、框选/箭头/文字标注、删除确认"],
            ["项目与恢复", "SQLite、事务、迁移、.lapian 项目包、素材打包、ID 重映射、会话恢复"],
            ["导出与统计", "PDF/Word 八列分镜本、镜头范围、表头、图片策略、标签笔记合并、三类统计图"],
            ["AI 与 MCP", "五类 AI 任务、项目快照、11 个 MCP 工具、本机回环、Token 和写操作授权"],
            ["安装与维护", "内置 Python/OpenCV、本地 AI 离线资源、NSIS 安装、独立安全卸载、运行时自动获取"],
        ],
    )
    p = doc.add_paragraph()
    add_inline(p, "尚未实现：链接导入、第二路可合成视频轨、真实 A1 混音、多时间线、波纹编辑、转场、代码签名和自动更新。")

    props = doc.core_properties
    props.title = "个人拉片工作台使用与开发说明"
    props.subject = "Personal Film Lab v0.1.9 用户手册"
    props.author = "Personal Film Lab"
    props.keywords = "拉片, 分镜, Electron, Vue, Qwen3-VL, OpenCV"
    props.comments = "Generated from docs/USER_GUIDE.md and reviewed for external distribution."
    output.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output)
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate the Personal Film Lab Word manual from USER_GUIDE.md.")
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    build(args.source, args.output)
