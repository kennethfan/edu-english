#!/usr/bin/env python3
"""生成主包元数据：core/books-meta.js（书名/学段）+ core/audiomap.js（词哈希→分包归属）。

独立于 miniapp_extract.py：装配重跑后执行一次即可（读 packages/*/audio 文件名反推归属）。

用法:
    python3 scripts/gen_meta.py
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_HTML = ROOT.parent / "单词匹配精校版-PEP-CET-全26册.html"
MINIAPP = ROOT / "miniapp"


def load_data() -> dict:
    s = SOURCE_HTML.read_text(encoding="utf-8")
    marker = "window.__WORD_MATCH_DATA__ = "
    i = s.index(marker) + len(marker)
    depth, j, in_str, esc = 0, i, False, False
    while j < len(s):
        c = s[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    j += 1
                    break
        j += 1
    return json.loads(s[i:j])


def main() -> int:
    data = load_data()
    books = data["books"]

    # ---- books-meta.js：册元数据（label/stage 等原样保留）----
    meta_js = ("// 自动生成：scripts/gen_meta.py — 勿手改\n"
               "module.exports = " +
               json.dumps({"books": books}, ensure_ascii=False,
                          separators=(",", ":")) + ";\n")
    (MINIAPP / "core" / "books-meta.js").write_text(meta_js, encoding="utf-8")
    print(f"[ok] books-meta.js：{len(books)} 册")

    # ---- audiomap.js：扫 packages/*/audio/*.mp3 反推 词哈希→分包 ----
    audiomap = {}
    pkgs_dir = MINIAPP / "packages"
    for pkg_dir in sorted(pkgs_dir.iterdir()):
        audio_dir = pkg_dir / "audio"
        if not audio_dir.is_dir():
            continue
        for f in audio_dir.iterdir():
            if f.suffix == ".mp3":
                audiomap[f.stem] = pkg_dir.name
    am_js = ("// 自动生成：scripts/gen_meta.py — 勿手改\n"
             "module.exports = " +
             json.dumps({"map": audiomap}, separators=(",", ":")) + ";\n")
    (MINIAPP / "core" / "audiomap.js").write_text(am_js, encoding="utf-8")
    print(f"[ok] audiomap.js：{len(audiomap)} 条音频归属 "
          f"({(MINIAPP / 'core' / 'audiomap.js').stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
