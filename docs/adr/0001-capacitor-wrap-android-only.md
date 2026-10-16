# ADR 0001 — 用 Capacitor 8 封装现有单文件 HTML，仅发布 Android

- 状态：**已接受**
- 日期：2026-10-16
- 相关：`../CONTEXT.md`（设计决策活文档，D1–D12）

## 背景

资产 `单词匹配精校版-PEP-CET-全26册.html` 是一个**单文件、离线、自包含**的英语单词配对游戏：

- Bootstrap 5.3.3 与 Alpine.js 均**内联**，无任何 CDN 外链；
- 数据 `window.__WORD_MATCH_DATA__` 已内嵌（26 册 / 3441 关 / 20191 词对，文件约 2 MB）；
- 已带 `<meta viewport>` 与 Bootstrap 响应式断点，**移动端无需重写 UI**；
- 关键事实：该文件本身就是 **Story-Creator 单页导出件** —— `window.__WM_STANDALONE__ = true` 已置位，导致 `ensureCet()` 不发网络请求、导出/退出入口被 `if (window.__WM_STANDALONE__) return;` 提前返回。

运行时依赖 `localStorage`（进度/错题）、`speechSynthesis`（en-US 发音）、`AudioContext`（音效）。

需要把它变成**可侧载的 Android 应用**，受众为自用 + 免费分发（不上应用商店）。

## 决策

**用 Capacitor 8 把现有 HTML 原样封装为 Android 应用，零源码重写；本次只发布 Android。**

具体：
1. `webDir = www`，`www/index.html` = 原 HTML 的改造副本；原 HTML 只读保留。
2. `server.androidScheme = "https"` —— **首版即固定**（发布后不可改，否则 origin 变化会让 localStorage 全部失效）。
3. 发音：Android WebView **不支持 `speechSynthesis`**，用 `@capacitor-community/text-to-speech` 顶替，走原生 `TextToSpeech`。
4. 进度：WebView 的 `localStorage` 被 Capacitor 官方明示为 **transient（系统可回收）**，用 `@capacitor/preferences` 做持久化镜像 + 启动回填。
5. 上述两项通过一个**独立 shim**（`src/shim.js`）注入，**不改动游戏源码一个字符**。
6. 范围锁定 **Android-only**：小程序与桌面端本次不做。

## 被否方案

| 方案 | 否决理由 |
|---|---|
| **uni-app / Taro 重写** | 需重写全部玩法/判分逻辑，且 App 打包**强依赖 HBuilderX**（本机无），成本与风险远高于收益 |
| **微信小程序（套壳 web-view）** | 个人主体**禁用 `web-view`**；且小程序无 DOM / Web Speech / AudioContext / localStorage，2 MB 数据须分包或上云开发，须 ICP 备案，发音须同声传译插件（**个人主体无法申请**）→ 等于重写 |
| **桌面端（Tauri v2）** | 技术可行且成本低，但**用户明确取消**（D1） |
| **iOS** | 需完整 Xcode + $99/年开发者账号，与「自用 + 免费分发」定位不符 |

## 后果

**正面**
- 零重写，玩法/词库/判分逻辑与原版**逐字节一致**，无回归风险。
- 单条命令链可重复出包：`npm run sync` → `apk:debug` / `apk:release`。
- 一套 web 资产，未来若要加桌面端（Tauri）或 iOS，复用成本极低。

**负面 / 约束**
- 引入了 Android 原生工程与 Gradle/AGP/JDK 21 工具链依赖，出包链条变长。
- `androidScheme: "https"` 一旦发布即**锁死**，后续不可回退。
- WebView 层与原生 TTS 的时序需自行对齐：shim 在 `TextToSpeech.speak` 完成后按**估算时长**补齐等待再回调 `onend`，以保证自动连播节奏（估算公式见 `src/shim.js`）。
- 原生 TTS 音色/语速由系统决定，不同设备音色略有差异（可接受）。

## 验证方式

1. `cd android && ./gradlew assembleDebug` → 产出 `app/build/outputs/apk/debug/app-debug.apk`。
2. 真机 `adb install -r` 侧载（TTS 必须真机才准）。
3. 逐项验收：26 册均可进入并游玩；判分与原版一致；英文发音可用；杀进程重启后进度仍在。
