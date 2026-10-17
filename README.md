# 单词对对碰

人教版小学 / 初中 / 高中 + 大学四六级词库的**单词配对练习**工具，双端同源：
**微信小程序** + **Android App（Capacitor）**，判分 / 出题 / 音频逻辑逐字节一致。

- 词库：26 册 · 3442 关 · 13632 词条 · 9085 条发音音频（离线可玩）
- 功能：选册续玩、配对玩法、进度持久化、自动学习（自动配对跟读）、错题本（错词重刷）
- 双主题：儿童模式（暖奶油，默认）/ 深色模式（石墨蓝灰），右下角浮动钮切换

## 仓库结构

```
├── 单词匹配精校版-PEP-CET-全26册.html   # 词库与游戏逻辑的唯一源头（只读，勿改）
│                                         # 位于仓库上级目录 edu/ 下
├── scripts/                             # 构建 / 生成脚本
│   ├── prepare-www.mjs                  #   生成 www/index.html（复制源 HTML + 注入 shim 与主题补丁）
│   ├── theme-patch.css / .js            #   App 端双主题补丁（与小程序同 token）
│   ├── make-audio.py                    #   edge-tts 合成发音 → .work/raw（原始 MP3 池）
│   ├── miniapp_extract.py               #   小程序分包装配（关级贪心装箱 + canonical 音频去重）
│   └── gen_meta.py                      #   生成小程序主包元数据（书名册 / 词→包音频归属）
├── miniapp/                             # 微信小程序（M0-M2 全量）
│   ├── core/                            #   pkgs/loaders/game/store/theme/audiomap/books-meta
│   ├── pages/                           #   index（首页）/ books（选册）/ game（配对）/ wrong（错题本）
│   └── packages/b01..b28/               #   分包（data.js + 占位页；audio/ 为生成产物不入库）
├── www/                                 # Android App 的 Web 资产（生成产物）
├── android/                             # Capacitor 8 原生工程
└── docs/                                # 设计文档 / ADR
```

## 双端架构与同源性

```
源 HTML（__WORD_MATCH_DATA__ 词库 + 游戏逻辑，唯一事实源）
   │
   ├─ scripts/prepare-www.mjs ──► www/index.html（App 端，注入 shim + 主题补丁）
   │                                  └─ Capacitor 打包 → android/ → APK
   └─ scripts/miniapp_extract.py ──► miniapp/packages/（关级粒度装箱成 28 个分包）
                                     core/pkgs.js、loaders.js（静态路径 require.async）
```

- **判分口径**（`sameMeaning`：跨侧按释义相等、同侧退回 key）、错配锁定 620ms、
  零错 = perfect 等规则与 App 线逐字节同源
- **音频 canonical 去重**：每个词的音频只存「首次装到它的分包」，跨包引用
  由 `core/audiomap.js`（词哈希 → 分包）解析；词哈希为双盐 FNV-1a 32（UTF-8 字节），
  三端（源 HTML / App / 小程序）逐字节一致
- **主题**：一套视觉 token 两端共用（`--wm-*` / CSS 变量），kids 默认

## 构建与开发

### 小程序（微信开发者工具）

```bash
# 1. 分包装配（前置：.work/raw 有原始音频池；音频已存在于池中则幂等续传）
python3 scripts/miniapp_extract.py
python3 scripts/gen_meta.py          # 生成 books-meta.js / audiomap.js

# 2. 微信开发者工具打开 miniapp/ 目录即可
# 3. 上传体验版（注意清掉 shell 代理变量，见下）
env -u http_proxy -u https_proxy -u all_proxy \
    -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    /Applications/wechatwebdevtools.app/Contents/MacOS/cli upload \
    --project $(pwd)/miniapp -v 0.1.1 -d "双主题+错题本"
```

包体约束：单分包 < 2M（装配目标 1.5M，`LIMIT` 可调）、总包 < 30M、
主包 < 1.5M（当前 ~250KB，含 222KB 词→包音频归属表）。

### Android App

```bash
node scripts/prepare-www.mjs         # 重生成 www/index.html（幂等）
npx cap sync android                 # www → 原生工程
# Android Studio 打开 android/ 构建 APK
```

### 生成产物（不入库，可重建）

`www/`、`www/audio/`、`.work/`（原始合成音频 / 索引 / 断点清单）、
`miniapp/packages/*/audio/` 均在 `.gitignore` 中——克隆后跑上述脚本重建。

## 已知坑（踩过一次就记下）

| 坑 | 处置 |
|---|---|
| IDE 2.x「上传失败：网络请求错误」 | 系统代理（Clash 7890）拦截微信上传通道：IDE 设置→代理→不使用任何代理 |
| CLI 上传 ECONNREFUSED 127.0.0.1:7890 | shell 级代理环境变量指向死端口：命令前加 `env -u …` 清变量 |
| CLI 二维码路径无效 | IDE 沙盒写不了 `/tmp`，`--qr-output` 用项目内路径 |
| `require.async` 找不到模块 | 相对路径以**声明文件所在目录**解析，`core/loaders.js` 应为 `../packages/…` |
| 沙箱/终端批量删除进程被杀 | 装配脚本跑前先 `mv` 旧 `packages` 目录、输出落文件后台执行 |

## 文档

- `docs/miniprogram-plan.md` — 小程序端里程碑规划（M0-M2）
- `docs/adr/` — 关键决策记录
