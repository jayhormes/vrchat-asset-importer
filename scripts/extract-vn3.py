#!/usr/bin/env python3
"""
Extract the "R." row status from a VN3 Avatar License PDF.

VN3 license tables list rights items A〜W. Row R is:
  「製品開発等のためにソフトウェア（ゲームを含みます）へ組み込み」
  (incorporate the data into commercial software like games)

Usage:
  python3 extract-vn3.py <pdf_path>

Output (stdout, JSON):
  {"decision": "allow"|"inquire"|"prohibit",
   "matched_keyword": "...",
   "r_context": "..."}

Errors print JSON with an "error" field. Exit codes:
  0  success
  1  bad args
  2  pypdf not installed
  3  PDF unreadable
  4  R row not located
  5  R row found but no status keyword matched
"""
import sys
import re
import json


def fail(code, msg, **extra):
    out = {"error": msg, **extra}
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(code)


# ─── status keyword tables (LLM may extend) ───────────────────────
ALLOW_KW = [
    "許可します", "許可可能", "可能です", "認めます",          # JP
    "Permitted", "Allowed",                                     # EN
    "允許", "允许", "可以", "授權", "授权",                    # ZH
    "허용",                                                     # KO
    "○", "〇",
]
PROHIBIT_KW = [
    "許可しません", "不許可", "禁止します", "認めません",       # JP
    "Prohibited", "Not allowed", "Not permitted",               # EN
    "不允許", "不允许", "禁止", "不可",                        # ZH
    "금지",                                                     # KO
    "✕", "×", "✗",
]
INQUIRE_KW = [
    "個別に問い合わせ", "要相談", "個別問合",
    "個別問い合わせ", "問い合わせて下さい", "お問い合わせ",     # JP
    "Inquire", "Please contact", "Contact the rights",
    "Contact the right holder",                                 # EN
    "個別咨詢", "個別咨询", "请咨询", "需洽詢", "請洽",         # ZH
    "문의",                                                     # KO
    "△",
]


def find_r_context(text: str) -> str | None:
    """Locate the R. row body; prefer detailed clause (last match)."""
    matches = list(re.finditer(r"(?<![A-Za-z])R\.\s*", text))
    if not matches:
        return None
    m = matches[-1]
    # stop at next clause (S./T./U./section header like （7）/(8.))
    tail = text[m.end():]
    stop = re.search(r"(?<![A-Za-z])(?:[STUVWXYZ]\.|（\s*\d+\s*）|\(\s*\d+\s*\)|7\.|8\.)", tail)
    end = m.end() + (stop.start() if stop else 300)
    return text[m.start():end][:400]


def main():
    if len(sys.argv) < 2:
        fail(1, "usage: extract-vn3.py <pdf_path>")

    try:
        import pypdf  # type: ignore
    except ImportError:
        fail(2, "pypdf not installed", hint="pip3 install pypdf")

    try:
        reader = pypdf.PdfReader(sys.argv[1])
        raw = "\n".join((p.extract_text() or "") for p in reader.pages)
    except Exception as e:
        fail(3, f"pdf read failed: {e}")

    # pypdf inserts a space between every CJK char — compress.
    text = re.sub(r"(?<=[^\x00-\x7f])\s+(?=[^\x00-\x7f])", "", raw)
    text = re.sub(r"\s+", " ", text)

    ctx = find_r_context(text)
    if not ctx:
        fail(4, "R row not found", text_preview=text[:300])

    # priority: prohibit > inquire > allow (conservative)
    for kw in PROHIBIT_KW:
        if kw in ctx:
            print(json.dumps({"decision": "prohibit", "matched_keyword": kw, "r_context": ctx}, ensure_ascii=False))
            return
    for kw in INQUIRE_KW:
        if kw in ctx:
            print(json.dumps({"decision": "inquire", "matched_keyword": kw, "r_context": ctx}, ensure_ascii=False))
            return
    for kw in ALLOW_KW:
        if kw in ctx:
            print(json.dumps({"decision": "allow", "matched_keyword": kw, "r_context": ctx}, ensure_ascii=False))
            return

    fail(5, "no status keyword matched in R context", r_context=ctx)


if __name__ == "__main__":
    main()
