"""Minimal Markdown -> Zotero note HTML converter (src/zotero/markdown.ts port).

Supports: headings, bold, italic, inline code, links, code fences,
ordered/unordered lists, paragraphs. Everything else passes through as text.
"""

import html
import re


def _inline(md: str) -> str:
    out = html.escape(md, quote=True)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(^|[^*])\*([^*]+)\*", r"\1<em>\2</em>", out)
    out = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', out)
    return out


def markdown_to_html(md: str) -> str:
    lines = md.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    para: list[str] = []
    lst: dict | None = None
    code: list | None = None

    def flush_para() -> None:
        if para:
            out.append(f"<p>{'<br/>'.join(_inline(l) for l in para)}</p>")
            para.clear()

    def flush_list() -> None:
        nonlocal lst
        if lst:
            items = "".join(f"<li>{_inline(i)}</li>" for i in lst["items"])
            out.append(f"<{lst['type']}>{items}</{lst['type']}>")
            lst = None

    for raw_line in lines:
        line = re.sub(r"\s+$", "", raw_line)
        if code is not None:
            if line.startswith("```"):
                out.append(f"<pre><code>{html.escape(chr(10).join(code['lines']))}</code></pre>")
                code = None
            else:
                code["lines"].append(raw_line)
            continue
        if line.startswith("```"):
            flush_para()
            flush_list()
            code = {"lang": line[3:].strip(), "lines": []}
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            flush_para()
            flush_list()
            level = len(heading.group(1))
            out.append(f"<h{level}>{_inline(heading.group(2))}</h{level}>")
            continue
        ul = re.match(r"^\s*[-*+]\s+(.*)$", line)
        if ul:
            flush_para()
            if not lst or lst["type"] != "ul":
                flush_list()
                lst = {"type": "ul", "items": []}
            lst["items"].append(ul.group(1))
            continue
        ol = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
        if ol:
            flush_para()
            if not lst or lst["type"] != "ol":
                flush_list()
                lst = {"type": "ol", "items": []}
            lst["items"].append(ol.group(1))
            continue
        if line.strip() == "":
            flush_para()
            flush_list()
            continue
        flush_list()
        para.append(line)

    flush_para()
    flush_list()
    if code is not None:
        out.append(f"<pre><code>{html.escape(chr(10).join(code['lines']))}</code></pre>")
    return "\n".join(out)
