#!/usr/bin/env python3
"""为「单词对对碰」词库中的全部英文条目预生成离线音频。

为什么需要它：Android 的 speechSynthesis 依赖系统 TTS 引擎，而国内 ROM 普遍不预装
（实测小米 22011211C / Android 14 上零引擎），导致发音静默失效。把音频随包分发即可
彻底摆脱该依赖，且离线可用、音色统一。

用法:
    V=/Users/kenneth/.workbuddy/binaries/python/envs/tts
    $V/bin/python scripts/make-audio.py --voice en-US-JennyNeural --rate=-15%
    $V/bin/python scripts/make-audio.py --limit 20            # 小样验证
    $V/bin/python scripts/make-audio.py --jobs 10             # 调整并发
    $V/bin/python scripts/make-audio.py --transcode-only      # 只重转码（换编码时用，无需重跑 TTS）

设计要点:
  * **合成一条立刻转码一条**：网络等待与 CPU 编码交错，吞吐优于「全部合成完再统一转码」，
    且中途中断也不会一条可用音频都没有。
  * **两级断点续传**：.work/raw/<key>.mp3 与 www/audio/<key>.ogg 只要已存在即跳过。
  * **文件名用哈希**：原文含空格、单引号、弯引号(’) 等，直接做文件名不安全。
    双盐 FNV-1a 32 拼接成 16 位 hex；src/shim.js 里必须有一模一样的实现。

产出:
    www/audio/<key>.ogg       Opus 单声道 16kbps（已去首尾静音）
    .work/raw/<key>.mp3       原始 edge-tts 输出（重转码依据，勿删）
    .work/audio-index.tsv     调试用：key → 原文
"""

import argparse
import asyncio
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

FFMPEG = ("/Users/kenneth/anaconda3/envs/python3.12/lib/python3.12/"
          "site-packages/portable_ffmpeg/binaries/osx-amd64-latest/ffmpeg")

ROOT = Path(__file__).resolve().parent.parent
SOURCE_HTML = ROOT.parent / "单词匹配精校版-PEP-CET-全26册.html"
OUT_DIR = ROOT / "www" / "audio"
WORK_DIR = ROOT / ".work"
RAW_DIR = WORK_DIR / "raw"
INDEX_FILE = WORK_DIR / "audio-index.tsv"

# 去首尾静音 + 转 Opus。edge-tts 每条尾部都有约 0.3~0.7s 静音填充，
# 不裁掉会让自动连播「念完还愣一下」，且总体积显著变大。
# silenceremove 没有「只去首尾」的选项，故用 areverse 做两次实现尾部裁剪。
TRIM_FILTER = (
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,"
    "areverse,"
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,"
    "areverse"
)

# 与 src/shim.js 的 hashKey() 必须逐字节一致
FNV_PRIME = 16777619
SALT_A = 0x811C9DC5
SALT_B = 0x01234567

_fail_lock = threading.Lock()
FAILURES: list[str] = []


def hash_key(text: str) -> str:
    def fnv(data: bytes, basis: int) -> int:
        h = basis
        for b in data:
            h ^= b
            h = (h * FNV_PRIME) & 0xFFFFFFFF
        return h

    raw = text.encode("utf-8")
    return f"{fnv(raw, SALT_A):08x}{fnv(raw, SALT_B):08x}"


def load_texts() -> list[str]:
    """从原始 HTML 里取出 window.__WORD_MATCH_DATA__，收集去重后的英文条目。"""
    s = SOURCE_HTML.read_text(encoding="utf-8")
    marker = "window.__WORD_MATCH_DATA__ = "
    i = s.index(marker) + len(marker)
    depth = 0
    j = i
    in_str = False
    esc = False
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
    data = json.loads(s[i:j])

    seen: dict[str, None] = {}
    for _book, levels in data["levels"].items():
        for lv in levels:
            for p in lv.get("pairs", []):
                t = str(p.get("en", "")).strip()
                if t:
                    seen[t] = None
    return list(seen)


def build_tasks(texts: list[str]) -> list[tuple[str, str, Path, Path]]:
    """返回 (text, key, raw_path, ogg_path)，并检查哈希无冲突。"""
    tasks = []
    by_key: dict[str, str] = {}
    for t in texts:
        k = hash_key(t)
        if k in by_key and by_key[k] != t:
            raise SystemExit(f"[x] 哈希冲突: {k!r} 同时对应 {by_key[k]!r} 与 {t!r}")
        by_key[k] = t
        tasks.append((t, k, RAW_DIR / f"{k}.mp3", OUT_DIR / f"{k}.ogg"))
    return tasks


async def synth_raw(sem: asyncio.Semaphore, text: str, raw: Path,
                    voice: str, rate: str) -> bool:
    """合成原始 MP3。信号量只包住网络这一段，转码不占并发额度。"""
    import edge_tts

    if raw.exists() and raw.stat().st_size > 512:
        return True
    async with sem:
        for attempt in range(4):
            try:
                await edge_tts.Communicate(text, voice, rate=rate).save(str(raw))
                if raw.exists() and raw.stat().st_size > 512:
                    return True
            except Exception as exc:
                if attempt == 3:
                    with _fail_lock:
                        FAILURES.append(f"{text}: {exc}")
                    return False
                await asyncio.sleep(1.0 * (2 ** attempt))  # 指数退避，缓解限流
    return False


def transcode(raw: Path, out: Path) -> bool:
    cmd = [FFMPEG, "-y", "-v", "error", "-i", str(raw),
           "-af", TRIM_FILTER, "-ac", "1", "-ar", "24000",
           "-c:a", "libopus", "-b:a", "16k", "-application", "voip",
           "-vbr", "off", str(out)]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as exc:
        with _fail_lock:
            FAILURES.append(f"ffmpeg {raw.name}: {exc.stderr.decode()[:160]}")
        return False
    return out.exists() and out.stat().st_size > 256


async def process(sem, text, raw: Path, out: Path, voice, rate) -> None:
    if out.exists():
        return
    if await synth_raw(sem, text, raw, voice, rate):
        await asyncio.to_thread(transcode, raw, out)


async def run_all(todo, jobs: int, voice: str, rate: str) -> None:
    sem = asyncio.Semaphore(jobs)
    coros = [process(sem, t, raw, out, voice, rate) for (t, _k, raw, out) in todo]
    total = len(coros)
    step = max(1, total // 30)
    t0 = time.time()
    done = 0
    for fut in asyncio.as_completed(coros):
        await fut
        done += 1
        if done % step == 0 or done == total:
            elapsed = time.time() - t0
            ratev = done / elapsed if elapsed else 0
            eta = (total - done) / ratev if ratev else 0
            print(f"    {done}/{total}  {ratev:.1f}/s  已用 {elapsed/60:.1f}min  "
                  f"预计还需 {eta/60:.1f}min", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="en-US-JennyNeural")
    ap.add_argument("--rate", default="-15%")
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 条（小样验证）")
    ap.add_argument("--transcode-only", action="store_true",
                    help="跳过 TTS，只把 .work/raw 里的 MP3 重转码（换编码参数时用）")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    texts = load_texts()
    if args.limit:
        texts = texts[: args.limit]
    tasks = build_tasks(texts)

    if args.transcode_only:
        todo = [t for t in tasks if not t[3].exists()]
        print(f"[i] 仅转码：待处理 {len(todo)} 条")
        with __import__("concurrent.futures", fromlist=["ThreadPoolExecutor"]) \
                .ThreadPoolExecutor(max_workers=args.jobs) as ex:
            list(ex.map(lambda it: transcode(it[2], it[3]), todo))
    else:
        todo = [t for t in tasks if not t[3].exists()]
        print(f"[i] 英文条目 {len(tasks)} 条；待生成 {len(todo)} 条；"
              f"voice={args.voice} rate={args.rate} jobs={args.jobs}", flush=True)
        if todo:
            asyncio.run(run_all(todo, args.jobs, args.voice, args.rate))

    have = sum(1 for t in tasks if t[3].exists())
    total_bytes = sum(t[3].stat().st_size for t in tasks if t[3].exists())
    print(f"[ok] 音频 {have}/{len(tasks)} 条，合计 {total_bytes/1048576:.1f} MB"
          + (f"，平均 {total_bytes/have/1024:.1f} KB/条" if have else ""))
    if FAILURES:
        print(f"[!] 失败 {len(FAILURES)} 条（重跑本脚本会自动补齐）：")
        for f in FAILURES[:5]:
            print("     ", f)

    with INDEX_FILE.open("w", encoding="utf-8") as fh:
        for t, k, _r, _o in tasks:
            fh.write(f"{k}\t{t}\n")
    print(f"[i] 索引: {INDEX_FILE.relative_to(ROOT)}")
    return 0 if have == len(tasks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
