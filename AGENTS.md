# AGENTS.md — 给 AI 编码 agent 的项目说明

本文件是**接手本仓库的 agent 的上下文入口**：先读它，再动 `index.js`。

标记约定：
- **✅** 引用的代码位置与仓库事实，已在本仓库核实（读代码或跑命令）。
- **⚠️** 行为类结论（MiMo 服务端行为、酒馆内部行为、作者实测数字）：即使行号引用准确，本机也无法复核，**不要仅凭直觉推翻**。
- **🟡** 推断，未证实。

---

## 1. 项目是什么

SillyTavern（酒馆）的**第三方 TTS 供应商扩展**：把小米 MiMo 语音合成接进酒馆 TTS 面板，
装好后 Provider 下拉框多一个 `MiMo`。当前 `v2.1.0`，三种音色来源：**预置音色 / 音色设计 / 音色克隆**。

| 事实 | 值 | 依据 |
|---|---|---|
| 仓库文件 | `LICENSE` `README.md` `index.js` `manifest.json` + 本文档 `AGENTS.md` | ✅ `git ls-files` |
| 构建 / 测试 / 依赖 | **没有**。无 `package.json`、无测试、无 CI、无 `.gitignore`、无 npm 依赖 | ✅ 跟踪文件清单只有上面 4 个；工作区除本文档外没有别的文件 |
| 代码形态 | 单文件 ES module（`index.js`，**1358 行**），浏览器直接加载，**不过打包器** | ✅ 文件头 import 与 `manifest.json` 的 `"js": "index.js"` |
| 外部依赖 | 酒馆注入的全局：`$`（jQuery）、`toastr`；浏览器内建：`fetch` `indexedDB` `Blob` `FileReader` `TextDecoder` `AbortController` `URL` `atob` `document` | ✅ 全文没有 `import` jQuery/toastr（其余是浏览器内建，无需 import） |
| 唯一 import | `../../../../script.js`（`getRequestHeaders`/`eventSource`/`event_types`）、`../../tts/index.js`（`registerTtsProvider`/`saveTtsProviderSettings`） | ✅ `index.js:37-38` |
| 许可证 | MIT | ✅ `LICENSE:1` |
| git 状态 | `main` 跟踪 `origin/main`；v2.1.0（音色设计）已合入 `main`，提交见 `git log --oneline`（推送状态以 `git status` 为准） | ✅ `git log --oneline` |
| 本机 node | v24.15.0，`node --check index.js` 通过（退出码 0） | ✅ 实测 |

> **元信息不一致，改之前先问人**：git remote 是 `https://github.com/TomDan-GodsHand/SillyTavern-MiMoTTS.git`（✅ 可核实），
> 而 `manifest.json:9` 的 `homePage`、`README.md:28` 的 clone 地址、`LICENSE:3` 的署名都写 `ymf2317-tech`（✅ 可核实）。
> 🟡 **推断**：这是同一项目的另一个账号/改名 —— 未证实。不要擅自"统一"其中一处。

---

## 2. 代码地图（`index.js`，行号对应提交 `b4ef586`）

| 起始行 | 内容 |
|---|---|
| L1 | 顶部契约注释：Xing 头帧、播放方式、传输方式、克隆契约、**音色设计契约（含 400 报错原文）** —— **改动前必读** |
| L37 | 唯一的 import（酒馆两个模块） |
| L40 | 常量：`VERSION`、`MIMO_ENDPOINT`、`ST_RELAY_ROUTE`、`MODEL_PRESET`、`MODEL_CLONE`、`MODEL_DESIGN`、`CLONE_PREFIX`、`DESIGN_PREFIX`、`IDB_NAME` |
| L72 | `isAbortError` |
| L81 | `hasSpeakableText`（空文本保护） |
| L91 / L98 | `beginGeneration` / `abortActiveGeneration`（newest-wins 取消） |
| L109 | `toast` |
| L122 / L132 / L147 | `base64ToBytes` / `concatBytes` / `pcm16ToWav` |
| L182 / L200 / L209 / L220 | IndexedDB：`idbOpen` / `cloneGet` / `clonePut` / `cloneDelete` |
| L232 / L246 / L264 | `fileToBase64` / `normalizeAudioMime` / `bytesToHuman` |
| L274 | `class MiMoTtsProvider` |
| L305 | `settingsHtml`（面板 HTML 内联字符串） |
| L409 / L417 | `constructor` / `dispose` |
| L422 | `loadSettings`（未知设置项告警、`clones`/`designs` 归一、控件绑定） |
| L524 / L555 | `onSettingsChange`（数值夹取、**保留前缀告警**）/ `markSaved` |
| L564 / L583 / L640 | `renderCloneList` / `onCloneAdd` / `onCloneDelete` |
| L665 / L684 / L723 / L737 | `renderDesignList` / `onDesignAdd` / `onDesignDelete` / `buildDesignPrompt` |
| L742 / L746 / L752 / L763 | `checkReady` / `onRefreshClick` / `getVoice` / `fetchTtsVoiceObjects` |
| L779 / L794 / L798 | `resolveVoiceId` / `isCloneVoice` / `isDesignVoice` |
| L806 | `generateTts`（合成总入口） |
| L843 | `splitIntoChunks`（分段流水线切分） |
| L874 | `wholeTts`（逐批请求、边到边抛；`options.single` 供音色设计用） |
| L916 | `fetchWholeBytes`（分派：克隆 → 设计 → 中转 → 直连非流式） |
| L989 | `fetchCloneBytes` |
| L1046 | `fetchDesignBytes`（**绝不携带 `audio.voice`**） |
| L1096 / L1139 / L1156 | `chunkedTts` / `takeWavChunk` / `readSseAudio` |
| L1213 / L1230 | `postDirect` / `postJson`（带 api-key、错误翻译） |
| L1258 | `previewTtsVoice` |
| L1276 | `resolvePresetModel`（拦住"模型框被填成 voicedesign"） |
| L1286 / L1291 / L1297 | `designPreview` / `escapeHtml` / `escapeAttr` |
| L1305 / L1307 / L1326 / L1330 / L1344 | `registered` / `ensureOption` / `init` / `register` / `scheduleUi` |
| L1358 | 模块末尾直接调用 `register()` |

---

## 3. 硬约束（改动的禁区）

1. **不要把整段播放"优化"成流式 MP3 拼接。** MiMo 的 SSE 每块自带一个 MP3 Xing 头帧，拼起来每 ~0.3 秒"突"一下；
   所以整段播放必须走 `stream:false`（`fetchWholeBytes`），要分块只能用 `pcm16` + 本地封 WAV（`chunkedTts`）。
   依据：✅ 引用准确 `index.js:5-10`（注释）、`955`（`stream:false`）、`1099`（`pcm16`）、`1145`（`pcm16ToWav`）；⚠️ 头帧行为本身是作者实测。
2. **不要删掉空文本保护。** `hasSpeakableText` 在入口（L810）和每批（L883）各拦一次。
   依据：✅ `810`、`883`；⚠️「MiMo 对空串/纯标点返回 HTTP 500」来自注释的作者实测。
3. **不要删掉 newest-wins 取消。** 新请求一进来就 `abort()` 上一个（`beginGeneration` L91、`abortActiveGeneration` L98、
   `dispose` L419、入口 L818）；凡是新增的 `await`/循环，都要在耗时点前检查 `signal?.aborted`
   （L878、L893、L1101、L1127）。✅
   依据：✅ `index.js:61-107`；⚠️「酒馆 `resetTtsPlayback()` 只清队列、不通知供应商」是作者结论（酒馆侧行为）。
4. **音色 ID 的不变量**：预置音色 = 名字原样；克隆 = `clone:` 前缀（`voice_id`）+ `[克隆] ` 显示名；
   设计 = `design:` 前缀 + `[设计] ` 显示名（✅ `50-53`）；三种都要经 `resolveVoiceId` 归一（✅ `779-800`）。
   ⚠️「酒馆 voicemap 里存的是显示名、`generateTts` 收到的是 `voice_id`」是酒馆侧行为，本机无酒馆源码，**未复核**
   —— 但这正是 `resolveVoiceId` 存在的原因，别凭猜测删掉它。
5. **参考音频永远不进 `settings.json`**：音频本体在 IndexedDB（`mimo-tts-clones`/`clones`，✅ `58-59`、`182-229`），
   设置里只留 `{name, mime, bytes, createdAt}`（✅ `onCloneAdd`，L583）。**设计音色的描述文本相反**：
   只有几十字，直接放 `settings.designs`（✅ L300）。
6. **克隆的官方契约不要改**：`model=mimo-v2.5-tts-voiceclone`，`audio.voice` 必须是 `data:<mime>;base64,<样本>`
   （仅 mp3/wav，base64 ≤10MB），**文本放 `assistant` 消息**，风格放 `user`；克隆**只能直连**。✅ `989-1046`。
7. **音色设计的官方契约不要改**：`model=mimo-v2.5-tts-voicedesign`，**描述放 `user` 消息、正文放 `assistant` 消息**，
   并且 **`audio.voice` 绝对不能出现**——实测带上它直接 **HTTP 400**
   （`audio.voice is not supported for voice design model`）。所以它单独走 `fetchDesignBytes`（✅ L1046，payload 在 L1064）。
   设计音色**只能直连**，且**必须整段一次合成**（`options.single`，✅ L828）：因为它每次请求都重新设计，
   分批会让同一条消息里出现两种音色。
8. **「模型」输入框只能填预置模型。** 它是自由文本，被填成 `mimo-v2.5-tts-voicedesign` 时，预置音色（直连/分块）
   与中转都会带 `audio.voice` → 必然 400。已用 `resolvePresetModel()`（L1276）在 `postDirect`（L1216）与中转 body（L935）
   统一取值拦下，**别绕过它直接用 `this.settings.model`**。
9. **预置音色名不得占用保留前缀。** 名字以 `clone:` / `[克隆] ` / `design:` / `[设计] ` 开头会被 `resolveVoiceId` 的前缀分支
   劫持成克隆/设计音色（`generateTts` 只看前缀，见 L798）。`onSettingsChange` 会在控制台点名警告（L524 区块），
   但**不修改用户配置**。
10. **中转地址留空 = 不启用**，并给出明确报错；不要重新写死任何内网/默认中转地址。✅ `fetchWholeBytes`（L916）。
11. **用户可见文案保持中文、说人话**（`postJson` 已把 `Failed to fetch` 翻译成可操作提示，L1230）。✅
    已知例外：`getVoice` 抛给框架的 `TTS Voice name ... not found`（L752 区块内）与 toastr 标题 `MiMo TTS`（L109）是英文，别顺手改。
12. **不要引入构建步骤、打包器、npm 依赖或类型系统**：`index.js` 必须能被浏览器按单文件直接加载。
13. **不要改目录层级**：`../../../../script.js`、`../../tts/index.js` 是按
    `scripts/extensions/third-party/<扩展名>/index.js` 的位置算出来的（✅ 算术自洽），挪一层 import 立刻失效。
    ⚠️ 另一种安装位置 `data/<user>/extensions/mimo-tts/` 在酒馆里如何解析，本仓库无法验证。

---

## 4. 已知的坑与现状（比 README 更细的补充）

- **`wholeTts` 的 `options.single` 现在有调用方了**：音色设计（L828）。原因见上面第 7 条——分批会让设计音色漂移。
  克隆**不做**这个处理，因为它的音色由每次重传的样本钉住，分批不会漂移。
- **设计音色的三条实测结论**（v2.1.0 开发时用真实 Key 验的）：
  ① 带 `audio.voice` → 400；② 同一描述两次生成，音频长度 69528 / 57240 字节，**不固定**；
  ③ 30 字文本耗时 2.8s ~ 3.2s。所以"试听"不等于"待会儿听到的就是这个"，要稳定音色请改用克隆。
- **`fetchDesignBytes` / `fetchCloneBytes` 的入参是"已归一的 `voice_id`"，不是显示名**：
  它们内部直接 `slice(DESIGN_PREFIX.length)` / `slice(CLONE_PREFIX.length)`，显示名只能先过 `resolveVoiceId`（L779）。
  `generateTts` 和 `previewTtsVoice` 都已经这么做了；新增调用点时别把 `[设计] 名字` 直接喂进去。
- **同名的设计音色会被静默覆盖**（`onDesignAdd` 用 `filter(d => d.name !== name).concat({name, prompt})`，L684 区块），
  与克隆当年的行为一致。要改就两条路一起改，别只改一边。
- **`loadSettings` 会丢掉"有名字但描述为空"的设计音色**（L422 区块），并在控制台报出被忽略的数量；
  `fetchDesignBytes` 也要求描述非空 —— 改这里要两边一起改。
- **toastr 里的音色名没有转义**（`onDesignAdd` L684 区块、`onDesignDelete` L723 区块，克隆同理）。
  列表渲染走 `innerHTML` 但已转义（L1291/L1297）；toastr 这条只在酒馆把 `escapeHtml` 设为 false 时才是自伤型 XSS，
  且名字只有用户自己能输入，**已评估为可接受风险**，未改动（本机没有酒馆源码，无法判定 toastr 默认值）。
- **试听不受取消机制保护**：`previewTtsVoice`（L1258）调 `fetchWholeBytes` 时**没有传 signal**，也不走 `beginGeneration`，
  所以试听既不会被新请求打断，也不会打断正在朗读的生成。改这块要一并想清楚交互。✅
- **数值有夹取**：`chunk_seconds` 1-60、`pipeline_first` 5-200、`pipeline_max` 20-500（✅ `onSettingsChange`，L524）；
  `loadSettings` 对未知设置项 `console.warn` 后忽略（✅ L422）——新增设置项要同时改 `defaultSettings`（L274 区块）和控件绑定。✅
- **注册是幂等的**：`register()` 在文件末尾直接调用（✅ L1358），`init()`（L1326）内部也会调（✅ L1327）；
  `ensureOption` 会去重下拉框里重复的 `<option>`（✅ L1307），并在 0/500/1500/3000ms 与 `APP_READY` 时重试（✅ L1344）。
- **分段切分是几何增长**：首批 `pipeline_first`（默认 20），之后每批最多翻倍、封顶 `pipeline_max`（默认 120）。
  依据：✅ `splitIntoChunks`（L843）；⚠️「MiMo 生成速度约为播放速度的 2.5 倍」是作者实测。
- ⚠️ **作者实测、本仓库无法复核的酒馆行为**（来自 README 与代码注释，改动相关逻辑前请先在真实酒馆里验证）：
  酒馆的文本清洗发生在切段**之后**且**逐行**执行（所以"按段朗读"开着会让跨行正则静默失效）；
  播放器每换一次音源要重新解码等待 0.3~0.5 秒（分 N 块必卡 N-1 次）；`beforeunload` 不保存设置。

---

## 5. 改完怎么验证（没有测试，只能这样验）

1. **语法**：`node --check index.js` → 期望退出码 0。已在本机 **Node v24.15.0** 实测通过；
   没有 `package.json` 时 `node --check` 需要按 ESM 解析这个文件，**更早的 Node 版本未测**。
2. **逻辑自测台（可复用，脚本本身不入库）**：把 `index.js` 复制成临时 `.mjs`，只把 L37-38 两行 `import` 换成桩
   （`getRequestHeaders` / `eventSource` / `event_types` / `registerTtsProvider` / `saveTtsProviderSettings`），
   然后在测试脚本里先设 `globalThis.document` / `globalThis.window` / `globalThis.$`（jQuery 链式桩：
   `() => ({ val: () => '', prop: () => false, off() { return this; }, on() { return this; } })`），
   再 `await import(pathToFileURL(临时文件))`，即可直接实例化 `MiMoTtsProvider` 并断言：
   `resolveVoiceId` 的前缀归一、`loadSettings` 的归一化与告警、`fetchTtsVoiceObjects` 的三种来源、
   `buildDesignPrompt` 的拼接、`fetchDesignBytes` 的 payload（**断言 `audio` 里没有 `voice` 键**）、
   中转/缺描述的报错、5xx 重试、`generateTts` 的分派（设计必须 `single: true`）、
   `renderDesignList` 的转义与代理对安全、`resolvePresetModel` 对"模型框填成 voicedesign"的拦截。
   v2.1.0 用三轮共 **46 个断言**验过（v1 22 / v2 13 / v3 11，全绿）。
3. **真接口实测（可选，需要 Key，且必须用 `%TEMP%` 之类仓库外目录存产物）**：
   直接 `curl` 打 `https://api.xiaomimimo.com/v1/chat/completions`，用与 `fetchDesignBytes` 相同的 JSON。
   **不要把 Key 写进仓库任何文件**。v2.1.0 的结论（400 / 随机性 / 延迟）就是这么来的。
4. **静态自查**：`git diff` 只应包含你打算改的东西；不要在 `index.js` 上做全文件格式化。
5. **手工回归**（需要真实酒馆，安装位置 `data/<user>/extensions/mimo-tts/` 或 `public/scripts/extensions/third-party/mimo-tts/`，改完 Ctrl+Shift+R 硬刷新）：

| 场景 | 期望 |
|---|---|
| Provider 下拉框 | 有且只有一个 `MiMo` |
| 预置音色 + 整段播放 | 连贯无"突突"；长文本首批 ~1-2 秒出声 |
| 分块流式 | 有间断（这是设计上限，不是 bug） |
| 克隆：添加 / 试听 / 删除 | 添加后出现在 Voice Map；试听能出声；删除后参考音频一并消失 |
| **设计：添加 / 试听 / 删除** | 列表显示 `[设计] 名字` 与描述摘要；Voice Map 里可选；试听能出声；删除后描述一并消失 |
| **设计音色朗读长文本** | 全程音色一致（不分批），首音比预置音色慢 |
| **「模型」框填 voicedesign 后朗读预置音色** | 立刻报"该模型不接受 voice 字段"，而不是 MiMo 的 400 |
| 朗读中途切换消息 | 旧音频不再落地播放（不会"两条一起读"） |
| 整条都是元数据块的消息 | 不报 500，提示"没有可朗读的文字" |
| 中转模式且地址留空 | 明确报错，而不是静默失败 |
| 改完设置后刷新页面 | 设置仍在（含设计音色），面板底部显示"设置已保存 HH:MM:SS" |

6. **版本位点共五处**，改对外行为时一起对齐：`index.js` 文件头注释（L3）、`VERSION`（✅ `index.js:40`）、
   `manifest.json` 的 `version`（✅ `manifest.json:8`）、README 头部（✅ `README.md:6`）与更新日志（✅ `README.md:114`）。
   当前五处都是 `2.1.0`。

## 6. 提交纪律

- 历史里已有 **4 个同名/近义 message 的隐患点**：`0c3e02d`、`f6657f5`、`bc9015d` 三条 message 完全相同（都是 v2.0.0 合并）。
  **提交信息要写清实际改了什么**，别再加同名提交。v2.1.0 的两个提交（`f0f30f0` 功能 / `b4ef586` 复核修复）可按此对照。
- 一次提交只做一件事；README 的《先读这里》《开发者说明》是踩坑记录，改动与它们冲突时，先说明理由再改。
- 本文档 `AGENTS.md` 由 AI 生成并随代码入库；改它请按同样纪律单独提交，别和功能改动混在一起。

## 7. 汇报要求

对用户汇报时用中文；区分「已核实」「推断」「未验证」，写明你跑过什么命令、看到什么输出。
本机没有酒馆源码，任何关于酒馆内部行为的结论都只能标为未验证。
