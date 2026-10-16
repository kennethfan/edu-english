# ADR 0002 — 发音改为「内置音频包优先，原生 TTS 兜底」

- 状态：**已接受**
- 日期：2026-10-16
- 替代：ADR 0001 中「发音一律走 `@capacitor-community/text-to-speech`」这一条（其余部分仍然有效）

## 背景

ADR 0001 决定用 `@capacitor-community/text-to-speech`（即系统 `TextToSpeech`）顶替 WebView 缺失的
`speechSynthesis`。该方案在**有 TTS 引擎的设备**上工作良好（已在 Android 12 云实例上验证出声）。

但 release 包装到目标真机 **Xiaomi 22011211C（Android 14）** 后，**发音完全无声**。经六项独立检查
互相印证，该设备**零 TTS 引擎**：

```
settings get secure tts_default_synth        → null
pm list packages | grep tts                  → 空
cmd package query-services -a ...TTS_SERVICE → No services found
pm list packages -u -d | grep tts            → 空（连已禁用/已卸载的系统组件都没有）
dumpsys package | grep TTS_SERVICE           → 空
settings list secure | grep tts              → 无任何 tts_* 项
```

设备上确有 `com.miui.voiceassist`、`com.xiaomi.aiasst.service`、`com.xiaomi.aicr` 等小米语音包，
但它们**都不注册标准 `TTS_SERVICE`**。这是国内 ROM 的常见形态：Google TTS 不预装，厂商自家语音
不开放标准接口。

这直接影响产品底线：D3 规定「英文发音**必须**」，而 D2 是「自用 + **免费分发**」——接收者大概率
也在国内 ROM 上，同样会遇到无声。**依赖系统 TTS 等于把核心功能交给运气。**

## 决策

**把全部词库英文条目的发音音频预生成并随 APK 分发；播放失败时才退回原生 TTS。**

具体：
1. 用 `edge-tts` 神经语音（`en-US-JennyNeural`，`rate=-15%`）为词库中**去重后 9085 个英文条目**
   预生成音频，离线随包分发。
2. 编码 **Opus 单声道 16kbps**，并**去除首尾静音**——edge-tts 原始输出（MP3 48kbps 24kHz）每条
   尾部带 0.3~0.7s 静音填充（"eraser" 原始 1.968s → 去静音后 0.807s），不裁会让体积翻倍且
   自动连播「念完愣一下」。
3. 文件名用 **双盐 FNV-1a 32 拼接成 16 位 hex**（原文含空格、单引号、弯引号 `’`，不能直接做文件名）。
   Python 生成侧与 JS 查找侧`必须有等价实现`，**两侧哈希已逐条比对验证一致**。
4. `src/shim.js` 的 `speak()` 改为：先 `new Audio('audio/<key>.ogg')` 播放，`ended` 事件即 `onend`；
   `error` 或 `play()` 被拒时**回退原生 TTS**。游戏源码依然零改动。
5. 保留 `.work/raw/*.mp3` 原始合成结果，使**重新编码无需重跑 TTS**（约 5 分钟 vs 约 1 小时）。

## 被否方案

| 方案 | 否决理由 |
|---|---|
| 维持原生 TTS，让用户自己装引擎 | 把核心功能变成用户侧的配置任务；免费分发场景不可控，等于发音功能随机可用 |
| 内置离线 TTS 引擎（eSpeak-NG WASM，约 3~5MB） | 体积更小、词库无限，但音色明显机械，对儿童学词体验伤害大 |
| 不处理，接受无声 | 违背 D3「发音必须」 |

## 后果

**正面**
- **任何 Android 设备必然有声**，与系统 TTS 引擎是否存在完全解耦。
- 离线可用；音色在所有设备上**完全一致**（不再随厂商引擎变化，修掉了 ADR 0001 记的「音色由系统决定」缺陷）。
- 时长精确：用 `ended` 事件驱动 `onend`，比原先「按文本长度估算等待」更准，自动连播节奏更好。
- 顺带修掉静音填充带来的听感延迟。

**负面 / 约束**
- **APK 体积大幅增加**：装机实测图标资源后为 3.68MB（release），音频预计再增约 15~20MB。
- 词库变更后**必须重新生成音频**（增量生成，已存在的会跳过）。
- 引入了构建期的外部依赖：`edge-tts`（网络服务）+ `ffmpeg`（转码）。
  两者版本敏感——**edge-tts 7.2.8 会因 `Sec-MS-GEC` token 算法过期而全线 403，需 7.3.1 及以上**。
- `hashKey()` 在 Python 与 JS 两处实现，**必须同步修改**，否则全部查不到音频（会在构建期体现为「无声」）。
- Opus/Ogg 依赖 Chromium 解码（Android 7+ WebView 均支持）。若不放心，可只重转码为 MP3 24kbps
  而无需重跑合成。

## 验证方式

1. `npm run audio` 生成音频；检查条数与总体积。
2. `npm run sync` → `npm run apk:release` 出包；确认 APK 内含 `assets/public/audio/*.ogg`。
3. 装到**零 TTS 引擎的设备**（Xiaomi 22011211C）实测：点喇叭有声；「自动学习」连播节奏正常。
