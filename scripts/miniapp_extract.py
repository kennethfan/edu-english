#!/usr/bin/env python3
"""从原 HTML 抽取词库 → 小程序分包 v2（关卡粒度贪心装箱）。

背景：按「2 册/包」切分在 CET 册上被击穿（cet-4+cet-6 = 12.37MB >> 2M 单包上限）。
v2 改为按 level 粒度贪心装箱：单册的 levels 可以跨包，游戏页按 core/pkgs.js 的
book→pkgs 清单加载一册所需的全部包。

用法:
    V=/Users/kenneth/.workbuddy/binaries/python/envs/tts
    $V/bin/python scripts/miniapp_extract.py            # 全量打包（M1 主路径）

输入:  原始 HTML __WORD_MATCH_DATA__ + .work/raw/<key>.mp3（edge-tts 原始 48kbps）
输出:  miniapp/packages/bNN/{data.js,audio/<key>.mp3}
       miniapp/core/pkgs.js                  pkgs 数组 + book→pkgs 映射
       miniapp/app.json                      subpackages 段自动重写
       .work/miniapp-manifest.json           装箱清单
"""

import json
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

FFMPEG = ("/Users/kenneth/anaconda3/envs/python3.12/lib/python3.12/"
          "site-packages/portable_ffmpeg/binaries/osx-amd64-latest/ffmpeg")

ROOT = Path(__file__).resolve().parent.parent
SOURCE_HTML = ROOT.parent / "单词匹配精校版-PEP-CET-全26册.html"
RAW_DIR = ROOT / ".work" / "raw"
POOL = ROOT / ".work" / "miniapp-audio"
MINIAPP = ROOT / "miniapp"
MANIFEST = ROOT / ".work" / "miniapp-manifest.json"

LIMIT = 1_350_000          # 单分包音频预算（+data.js 开销≈6% 后总重 <1.5M，避开 IDE 1.5M 检查线；硬限 2M）
TOTAL_LIMIT = 27_000_000   # 全部分包总上限（微信硬限 30M）

TRIM_FILTER = (
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,"
    "areverse,"
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,"
    "areverse"
)

FNV_PRIME = 16777619
SALT_A = 0x811C9DC5
SALT_B = 0x01234567


def hash_key(text: str) -> str:
    def fnv(data: bytes, basis: int) -> int:
        h = basis
        for b in data:
            h ^= b
            h = (h * FNV_PRIME) & 0xFFFFFFFF
        return h

    raw = text.encode("utf-8")
    return f"{fnv(raw, SALT_A):08x}{fnv(raw, SALT_B):08x}"


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


def transcode(raw: Path, out: Path) -> bool:
    if out.exists() and out.stat().st_size > 256:
        return True
    cmd = [FFMPEG, "-y", "-v", "error", "-i", str(raw),
           "-af", TRIM_FILTER, "-ac", "1", "-ar", "24000",
           "-c:a", "libmp3lame", "-b:a", "16k", str(out)]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as exc:
        print(f"  [!] ffmpeg 失败 {raw.name}: {exc.stderr.decode()[:120]}", file=sys.stderr)
        return False
    return out.exists() and out.stat().st_size > 256


def mkdir_p(p: Path) -> None:
    # 沙箱 mkdir shim 对已存在目录会误报 EEXIST，先判存在
    if not p.exists():
        p.mkdir(parents=True)


def compact_level(lv: dict) -> dict:
    return {"i": lv.get("index"), "t": lv.get("theme", ""),
            "p": [[p.get("key", ""), p.get("en", ""), p.get("zh", "")]
                  for p in lv.get("pairs", []) if str(p.get("en", "")).strip()]}


def main() -> int:
    data = load_data()
    books = list(data["levels"].keys())
    print(f"[i] 共 {len(books)} 册")

    # ---- 1. 展平成 level 列表，收集唯一词 ----
    levels_flat = []          # (book, compact_lv)
    need = {}                 # key -> en
    for book in books:
        for lv in data["levels"][book]:
            clv = compact_level(lv)
            levels_flat.append((book, clv))
            for _k, en, _z in clv["p"]:
                need[hash_key(en)] = en
    print(f"[i] levels={len(levels_flat)}  唯一词={len(need)}")

    # ---- 2. 全量转码进音频池（唯一一份，装箱时硬链接）----
    mkdir_p(POOL)
    todo = [(k, POOL / f"{k}.mp3") for k in need]
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda t: transcode(RAW_DIR / f"{t[0]}.mp3", t[1]), todo))
    bad = [k for (k, _), ok in zip(todo, results) if not ok]
    if bad:
        print(f"[x] {len(bad)} 条转码失败，终止: {bad[:5]}", file=sys.stderr)
        return 1
    size = {k: (POOL / f"{k}.mp3").stat().st_size for k in need}
    print(f"[i] 音频池 {len(size)} 条 / {sum(size.values()) / 1048576:.1f} MB")

    # ---- 3. 关卡粒度贪心装箱（保持册序、关序）----
    packages = []             # [(items, bytes)]
    cur, cur_bytes = [], 0
    for book, clv in levels_flat:
        lv_bytes = sum(size[hash_key(en)] for _k, en, _z in clv["p"])
        if cur and cur_bytes + lv_bytes > LIMIT:
            packages.append((cur, cur_bytes))
            cur, cur_bytes = [], 0
        cur.append((book, clv))
        cur_bytes += lv_bytes
    if cur:
        packages.append((cur, cur_bytes))
    npkg = len(packages)
    print(f"[i] 装箱 {npkg} 个（音频 canonical 去重后总体积≈音频池 {sum(size.values()) / 1048576:.1f} MB）")

    # ---- 4. canonical 去重：每个词的音频只存「首次装到它的包」----
    # 依据：pep↔CET 重叠极小(45~211词)，cet-4/6 相邻且互重 —— 额外跨包加载可忽略
    pkg_items = []
    audio_owner = {}          # key -> pkg
    for idx, (items, _b) in enumerate(packages, 1):
        pkg = f"b{idx:02d}"
        pkg_items.append((pkg, items))
        for book, clv in items:
            for _k, en, _z in clv["p"]:
                k = hash_key(en)
                audio_owner.setdefault(k, pkg)

    # ---- 5. 落盘分包 ----
    pkgs_dir = MINIAPP / "packages"
    if pkgs_dir.exists():
        # 注意：沙箱对 rmtree/rm 的批量删除会直接杀进程，外部先 mv 走旧目录再跑本脚本
        print("[!] packages 目录已存在：将就地覆盖写入（残留旧音频请先 mv 走目录再跑）")
    manifest, book_pkgs, book_audio_pkgs, samples, cross_samples = [], {}, {}, {}, []
    for pkg, items in pkg_items:
        root = pkgs_dir / pkg
        mkdir_p(root / "audio")
        mkdir_p(root / "pages" / "blank")
        # 占位页（微信要求每分包至少一个页面）
        (root / "pages" / "blank" / "blank.js").write_text("Page({});\n")
        (root / "pages" / "blank" / "blank.json").write_text('{"usingComponents":{}}\n')
        (root / "pages" / "blank" / "blank.wxml").write_text(
            '<view style="padding:40rpx;color:#8a93a6">占位页</view>\n')
        # 数据 + 音频归属
        books_in, levels_map = [], {}
        stored = 0
        for book, clv in items:
            if book not in levels_map:
                levels_map[book] = []
                books_in.append(book)
            levels_map[book].append(clv)
            book_pkgs.setdefault(book, [])
            if pkg not in book_pkgs[book]:
                book_pkgs[book].append(pkg)
            for _k, en, _z in clv["p"]:
                k = hash_key(en)
                owner = audio_owner[k]
                book_audio_pkgs.setdefault(book, set())
                book_audio_pkgs[book].add(owner)
                if owner == pkg:
                    dst = root / "audio" / f"{k}.mp3"
                    if not dst.exists():
                        try:
                            import os as _os
                            _os.link(POOL / f"{k}.mp3", dst)
                        except OSError:
                            shutil.copy2(POOL / f"{k}.mp3", dst)
                        stored += 1
                    if pkg not in samples:
                        samples[pkg] = en          # 同包抽检词
                elif len(cross_samples) < 6 and not any(
                        c["text"] == en for c in cross_samples):
                    cross_samples.append({"levelPkg": pkg, "audioPkg": owner, "text": en})
        js = ("// 自动生成：scripts/miniapp_extract.py — 勿手改\n"
              "module.exports = " + json.dumps(
                  {"books": books_in, "levels": levels_map},
                  ensure_ascii=False, separators=(",", ":")) + ";\n")
        (root / "data.js").write_text(js, encoding="utf-8")
        pkg_bytes = (root / "data.js").stat().st_size + \
            sum(f.stat().st_size for f in (root / "audio").glob("*.mp3"))
        manifest.append({"pkg": pkg, "members": books_in,
                         "levels": len(items), "bytes": pkg_bytes,
                         "audio_stored": stored})
        print(f"[ok] {pkg}: {'+'.join(books_in)} — {len(items)} 关 / "
              f"{stored} 音频 / {pkg_bytes / 1048576:.2f} MB")
        if pkg_bytes > 2_000_000:
            print(f"  [!] 超微信单包 2M 硬限！", file=sys.stderr)

    # ---- 6. 主包清单 core/pkgs.js + loaders.js + app.json ----
    mkdir_p(MINIAPP / "core")
    (MINIAPP / "core" / "pkgs.js").write_text(
        "// 自动生成：scripts/miniapp_extract.py — 勿手改\n"
        "module.exports = " + json.dumps(
            {"pkgs": [m["pkg"] for m in manifest],
             "books": books,
             "bookPkgs": book_pkgs,
             "bookAudioPkgs": {b: sorted(v) for b, v in book_audio_pkgs.items()},
             "samples": samples,
             "crossSamples": cross_samples},
            ensure_ascii=False, separators=(",", ":")) + ";\n")

    # 分包异步化的 require.async 路径必须可静态分析（字面量），
    # 动态模板字符串会让编译器/模拟器卡死 —— 逐包生成静态加载器
    loaders = ["// 自动生成：scripts/miniapp_extract.py — 勿手改",
               "// 每个分包一个静态路径加载器（分包异步化要求字面量路径）",
               "module.exports = {"]
    for m in manifest:
        loaders.append(f"  {m['pkg']}: () => require.async('../packages/{m['pkg']}/data.js'),")
    loaders.append("};\n")
    (MINIAPP / "core" / "loaders.js").write_text("\n".join(loaders), encoding="utf-8")

    app_json_path = MINIAPP / "app.json"
    app_cfg = json.loads(app_json_path.read_text(encoding="utf-8"))
    app_cfg["subpackages"] = [
        {"root": f"packages/{m['pkg']}", "pages": ["pages/blank/blank"]}
        for m in manifest
    ]
    app_json_path.write_text(
        json.dumps(app_cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total_bytes = sum(m["bytes"] for m in manifest)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    print(f"[i] app.json subpackages 已重写；清单 {MANIFEST.relative_to(ROOT)}")
    print(f"[i] 总体积 {total_bytes / 1048576:.1f} MB（硬限 30M）｜"
          f"音频去重存 {sum(m['audio_stored'] for m in manifest)} 条（池 {len(size)} 条）")
    spread = {b: len(v) for b, v in book_audio_pkgs.items()}
    worst = max(spread, key=spread.get)
    print(f"[i] 单册跨包最多: {worst} → {spread[worst]} 包")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
