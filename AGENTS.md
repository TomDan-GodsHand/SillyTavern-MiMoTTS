# AGENTS.md — 给 AI 编码 agent 的项目说明

本文件是**接手本仓库的 agent 的上下文入口**：先读它，再动 `index.js`。

标记约定：
- **✅** 引用的代码位置与仓库事实，已在本仓库核实（读代码或跑命令）。
- **⚠️** 行为类结论（MiMo 服务端行为、酒馆/Luker 内部行为、作者实测数字）：即使描述准确，本机也无法复核，**不要仅凭直觉推翻**。
- **🟡** 推断，未证实。

> 代码地图**不写行号**：这个文件只有 1 个源文件，行号每次提交都会漂；用函数名检索即可（`grep -n '函数名' index.js`）。

---

## 1. 项目是什么

SillyTavern / Luker 的**第三方 TTS 供应商扩展**：把小米 MiMo 语音合成接进 TTS 面板，
装好后 Provider 下拉框多一个 `MiMo`。当前 `v2.2.0`，四种音色来源：**预置音色 / 音色克隆 / 音色设计 / 自动音色设计**。

| 事实 | 值 | 依据 |
|---|---|---|
| 仓库文件 | `LICENSE` `README.md` `index.js` `manifest.json` + 本文档 | ✅ `git ls-files` |
| 构建 / 测试 / 依赖 | **没有**。无 `package.json`、无测试、无 CI、无 `.gitignore`、无 npm 依赖 | ✅ 跟踪文件清单只有 5 个文件 |
| 代码形态 | 单文件 ES module（`index.js`，**1583 行**），浏览器直接加载，**不过打包器** | ✅ 文件头 import 与 `manifest.json` 的 `"js": "index.js"` |
| 静态依赖 | 酒馆注入的全局：`$`（jQuery）、`toastr`、`SillyTavern.getContext()`；两个静态 import：`../../../../script.js`、`../../tts/index.js` | ✅ 全文 import 只有这两行 |
| 动态依赖（可选） | 自动音色设计会 `import('../../../lib/iter-tool-calling.js')`——**Luker 专有，原版酒馆没有** | ✅ 只在 `loadToolCallHelper` 里动态加载 |
| 许可证 | MIT；`manifest.json` 的 `author`/`homePage` 与 LICENSE 署名仍是 `ymf2317-tech` | ✅ 见 §1 末尾说明 |
| git 状态 | `main` 跟踪 `origin/main`（`TomDan-GodsHand/SillyTavern-MiMoTTS`）；v2.1.0 与 v2.2.0 已合入 | ✅ `git log --oneline` |
| 本机 node | v24.15.0，`node --check index.js` 通过（退出码 0） | ✅ 实测 |

> **地址与署名的来源不同**：README 的安装地址与 git remote 都是 `TomDan-GodsHand`（✅ 可核实）；
> 而 `manifest.json` 的 `author` / `homePage`、`LICENSE` 的版权署名仍是 `ymf2317-tech`。
> 🟡 推测那是上游作者/另一账号。**维护者已明确决定暂不改这几处**（署名与来源信息），别再动。

---

## 2. 代码地图（按职责，不写行号）

**顶层（模块级）**

| 名称 | 作用 |
|---|---|
| 文件头注释 | 全部契约：Xing 头帧、播放/传输方式、克隆契约、音色设计契约、自动音色设计契约 —— **改动前必读** |
| 常量区 | `VERSION`、`MIMO_ENDPOINT`、`ST_RELAY_ROUTE`、`MODEL_PRESET/CLONE/DESIGN`、`CLONE_PREFIX`、`DESIGN_PREFIX`、`DEFAULT_VOICE_MARKER`、`MULTI_VOICE_KEY_SUFFIXES`、`IDB_NAME` |
| `isAbortError` / `hasSpeakableText` | 取消判定 / 空文本保护 |
| `beginGeneration` / `abortActiveGeneration` | newest-wins 取消（全局单例 `activeController`） |
| `toast` | toastr 包装（无 toastr 时降级到 console） |
| `base64ToBytes` / `concatBytes` / `pcm16ToWav` | 字节与 WAV 封装 |
| `idbOpen` / `cloneGet` / `clonePut` / `cloneDelete` | 克隆样本的 IndexedDB 存取 |
| `fileToBase64` / `normalizeAudioMime` / `bytesToHuman` | 上传与展示工具 |
| `resolvePresetModel` | 「模型」框取值校验（拦住 voicedesign 被填到预置路径） |
| `extractSpeakerName` | 从 `voiceMapKey` 剥掉多音色后缀，取说话人名 |
| `loadToolCallHelper` | 动态加载 Luker 的 `iter-tool-calling.js`（带失败清缓存） |
| `AUTO_DESIGN_SYSTEM_PROMPT` / `buildAutoDesignUserPrompt` | 自动音色设计的提示词 |
| `designPreview` / `escapeHtml` / `escapeAttr` | 列表渲染与转义 |
| `ensureOption` / `init` / `register` / `scheduleUi` | 供应商注册与下拉框兜底（幂等） |

**`class MiMoTtsProvider`**

| 名称 | 作用 |
|---|---|
| `settingsHtml` | 面板 HTML（预置…/音色设计/自动音色设计/音色克隆） |
| `loadSettings` | 设置读取、`clones`/`designs` 归一（保留 `auto` 标记）、控件绑定 |
| `onSettingsChange` / `markSaved` | 数值夹取、保留前缀告警、保存时间提示 |
| `renderCloneList` / `onCloneAdd` / `onCloneDelete` | 克隆音色列表与增删 |
| `renderDesignList` / `onDesignAdd` / `onDesignDelete` / `buildDesignPrompt` | 设计音色列表与增删（AI 生成的标 `AI`） |
| `fetchTtsVoiceObjects` | 把 预置 + 克隆 + 设计 拼成选项列表 |
| `resolveVoiceId` / `isCloneVoice` / `isDesignVoice` | 音色 ID 归一与前缀判定 |
| `generateTts(text, voiceId, voiceMapKey)` | **合成总入口**（第 3 参是宿主传的 voiceMap 键，带说话人名） |
| `getHostContext` / `getLiveVoiceMap` / `resolveAutoDesignSpeaker` | 自动音色设计：宿主上下文、实时 voiceMap、判定是否接管 |
| `autoDesignTts` / `ensureAutoDesign` / `requestVoiceDescription` | 自动音色设计：合成入口、生成并落盘描述、调宿主模型 |
| `splitIntoChunks` | 分段流水线切分（几何增长） |
| `wholeTts` | 逐批请求、边到边抛；`options.single` 供音色设计用 |
| `fetchWholeBytes` | 分派：克隆 → 设计 → 中转 → 直连非流式 |
| `fetchCloneBytes` / `fetchDesignBytes` | 克隆合成 / 音色设计合成（后者**绝不带 `audio.voice`**） |
| `chunkedTts` / `takeWavChunk` / `readSseAudio` | pcm16 流式分块 |
| `postDirect` / `postJson` | 直连请求（带 api-key）/ 错误人话化 |
| `previewTtsVoice` | 试听（**不传 signal**，见 §4） |

---

## 3. 硬约束（改动的禁区）

1. **不要把整段播放"优化"成流式 MP3 拼接。** MiMo 的 SSE 每块自带 MP3 Xing 头帧，拼起来每 ~0.3 秒"突"一下；
   整段播放必须 `stream:false`，要分块只能用 `pcm16` + 本地封 WAV。✅ 引用准确；⚠️ 头帧行为是作者实测。
2. **不要删掉空文本保护。** `hasSpeakableText` 在 `generateTts` 入口与 `wholeTts` 每批各拦一次。
   ⚠️「MiMo 对空串/纯标点返回 HTTP 500」来自注释的作者实测。
3. **不要删掉 newest-wins 取消。** `generateTts` 一进来就 `beginGeneration()`；新增的 `await`/循环都要在耗时点前
   检查 `signal?.aborted`。⚠️「酒馆 `resetTtsPlayback()` 只清队列、不通知供应商」是作者结论。
4. **音色 ID 的不变量**：预置 = 名字原样；克隆 = `clone:` + `[克隆] `；设计 = `design:` + `[设计] `；
   三种都要经 `resolveVoiceId` 归一。⚠️「酒馆 voicemap 存显示名、`generateTts` 收 voice_id」是酒馆侧行为，未复核。
5. **参考音频永远不进 `settings.json`**（IndexedDB 存样本、设置只留元数据）；**设计音色的描述文本相反**，直接进 `settings.designs`。
6. **克隆的官方契约不要改**：`mimo-v2.5-tts-voiceclone` + `audio.voice = data:<mime>;base64,<样本>`，文本放 `assistant`，只能直连。
7. **音色设计的官方契约不要改**：`mimo-v2.5-tts-voicedesign`，描述放 `user`、正文放 `assistant`，**`audio.voice` 绝对不能出现**
   （实测带上直接 400：`audio.voice is not supported for voice design model`）。设计音色**只能直连**，且**必须整段一次合成**
   （`options.single`）：它每次请求都重新设计，分批会让一条消息里出现两种音色。
8. **「模型」输入框只能填预置模型。** 填成 voicedesign 会让预置/中转路径必然 400，已由 `resolvePresetModel` 拦下；
   **别绕过它直接用 `this.settings.model`**。
9. **预置音色名不得占用保留前缀**（`clone:` / `[克隆] ` / `design:` / `[设计] `），否则会被前缀分支劫持；
   `onSettingsChange` 只警告、不改用户配置。
10. **中转地址留空 = 不启用**，并给出明确报错；不要写死任何默认中转地址。
11. **用户可见文案保持中文、说人话**。已知例外：`getVoice` 抛给框架的 `TTS Voice name ... not found` 与 toastr 标题是英文。
12. **不要引入构建步骤、打包器、npm 依赖或类型系统**：`index.js` 必须能被浏览器按单文件直接加载。
13. **不要改目录层级**：`../../../../script.js`（根）与 `../../tts/index.js`（extensions/tts）都是相对定位，挪一层就失效。
14. **自动音色设计只能用宿主的既有能力，不要自建归属解析**：拿 `generateTts` 的第 3 参（说话人名）+
    provider voiceMap 里的 `[Default Voice]` 判定；模型调用复用宿主的归属解析连接/预设
    （`npcAttributionApiPresetName` / `npcAttributionPresetName`），**不要另加 key 配置**。
15. **宿主内部模块只能动态 import**（`import('../../../lib/iter-tool-calling.js')`）：原版酒馆没有这个文件，
    静态 import 会让整个扩展加载失败。
16. **自动音色设计失败必须回落默认音色**，不得抛错中断朗读；只在未被 abort 时提示用户。

---

## 4. 已知的坑与现状（比 README 更细的补充）

- **Luker 调 provider 的真实签名是 `generateTts(text, voiceId, voiceMapKey)`**（✅ 源码核实：
  `public/scripts/extensions/tts/index.js` 里 `tts()` → `ttsProvider.generateTts(text, voiceId, voiceMapKey)`）。
  第 3 参是多音色模式下带后缀的 voiceMap 键；原版酒馆只传两个参数。
- **"没配音色"的判定依据**：provider 的 voiceMap（`extension_settings.tts.<provider>.voiceMap`，✅ 源码核实）
  里该键的值是 `'[Default Voice]'`；`'disabled'` 表示禁用；宿主会把新 NPC **实时**写进这个对象，
  所以必须从 `getContext()` 读实时值，`this.settings.voiceMap` 是加载时的副本。
- **模型连接的复用方式**：`requestToolCallWithRetry(context, {toolCallRetryMax, rpmLimit}, {taskMessages, apiPresetName, llmPresetName, functionName, functionDescription, parameters, abortSignal})`，
  要求 `context.generateTask` 存在（Luker 专有）。✅ 源码核实。
- **设计音色的三条实测结论**：① 带 `audio.voice` → 400；② 同一描述两次生成音频长度不同（69528 / 57240 字节），**不固定**；
  ③ 30 字文本 2.8~3.2s。所以"试听"不等于"待会儿听到的就是这个"。
- **`wholeTts` 的 `options.single` 有两个调用方**：手动设计音色、自动设计音色。克隆**不分批的原因不同**（样本钉住音色）。
- **`fetchDesignBytes` / `fetchCloneBytes` 的入参是"已归一的 `voice_id`"，不是显示名**：显示名必须先过 `resolveVoiceId`。
- **同名设计音色/自动生成会覆盖旧的**（`filter(...).concat(...)`），与克隆历史行为一致；`loadSettings` 保留 `auto` 标记。
- **`loadSettings` 会丢掉"有名字但描述为空"的设计音色**并在控制台报数量，`fetchDesignBytes` 也要求描述非空——两边要一起改。
- **toastr 里的音色名未转义**（列表渲染已转义）；只在酒馆把 `escapeHtml` 设为 false 时才是自伤型 XSS，
  名字只有本机用户能输入，**已评估为可接受风险**。
- **试听不受取消保护**：`previewTtsVoice` 调 `fetchWholeBytes` 不传 signal，也不 `beginGeneration`。
- **注册是幂等的**：模块末尾直接 `register()`，`init()` 也会调；`ensureOption` 去重并按 0/500/1500/3000ms + `APP_READY` 重试。
- **版本位点共五处**：`index.js` 文件头注释、`VERSION`、`manifest.json` 的 `version`、README 头部、README 更新日志。当前都是 `2.2.0`。
- ⚠️ **作者实测、本机无法复核的宿主行为**：文本清洗在切段**之后**且**逐行**执行（"按段朗读"开着会让跨行正则静默失效）；
  播放器每换一次音源要重新解码 0.3~0.5s；`beforeunload` 不保存设置。

---

## 5. 改完怎么验证（没有测试，只能这样验）

1. **语法**：`node --check index.js` → 期望退出码 0（本机 Node v24.15.0 实测；更早版本未测）。
2. **逻辑自测台（可复用，脚本不入库）**：把 `index.js` 复制成临时 `.mjs`，仅把两行 `import` 换成桩
   （`getRequestHeaders` / `eventSource` / `event_types` / `registerTtsProvider` / `saveTtsProviderSettings`），
   测试脚本里先设 `globalThis.document` / `window` / `$`（jQuery 链式桩），再 `await import(pathToFileURL(...))`。
   覆盖：前缀归一、`loadSettings` 归一与告警、三种音色来源、`buildDesignPrompt`、`fetchDesignBytes` 的 payload
   （**断言 `audio` 里没有 `voice`**）、5xx 重试、`generateTts` 分派、`renderDesignList` 转义与代理对、
   `resolvePresetModel` 拦截、以及自动音色设计的判定/落盘/回落（用伪 `SillyTavern.getContext()` + 伪 voiceMap）。
   v2.2.0 用**四轮共 66 个断言**验过（22 / 13 / 11 / 20，全绿）。
3. **真接口实测（可选，需要 Key，产物放仓库外）**：`curl` 打 MiMo 端点，用与 `fetchDesignBytes` 相同的 JSON；
   **不要把 Key 写进仓库任何文件**。
4. **静态自查**：`git diff` 只应包含你打算改的东西；不要全文件格式化。
5. **手工回归**（需要真实 Luker/酒馆；装到 `data/<user>/extensions/mimo-tts/` 或 `public/scripts/extensions/third-party/mimo-tts/`，硬刷新）：

| 场景 | 期望 |
|---|---|
| Provider 下拉框 | 有且只有一个 `MiMo` |
| 预置音色整段播放 / 分块流式 | 连贯无"突突" / 有间断（设计上限） |
| 克隆：添加 / 试听 / 删除 | Voice Map 可选；删除后样本消失 |
| 设计：添加 / 试听 / 删除 | 列表显示 `[设计] 名字`；长文本音色一致（不分批） |
| **自动音色设计** | 勾选后，归属解析认出的未配音色 NPC 首次朗读会多一次模型调用并落盘 `[设计] 名字`（带 AI 标记）；之后复用 |
| **自动音色设计失败** | 关掉 / 换成原版酒馆 / 断网 → 回落默认音色，朗读不中断，控制台一条 warn |
| 「模型」框填 voicedesign 后朗读预置音色 | 立刻报"该模型不接受 voice 字段" |
| 朗读中途切换消息 | 旧音频不再落地（不会两条一起读） |
| 整条都是元数据块的消息 | 不报 500，提示"没有可朗读的文字" |
| 中转模式且地址留空 | 明确报错 |

---

## 6. 提交纪律

- 历史里有三条 message 完全相同的 v2.0.0 提交（`0c3e02d`/`f6657f5`/`bc9015d`）。**提交信息要写清实际改了什么**。
  可参照：`f0f30f0`（v2.1.0 功能）/ `b4ef586`（复核修复）/ `6911298`（AGENTS 入库）/ `05ec347`（README 地址）。
- 一次提交只做一件事；README 的《先读这里》《开发者说明》是踩坑记录，与之冲突时先说明理由。
- 本文档随代码入库；改它请单独提交，别和功能改动混在一起。

## 7. 汇报要求

对用户汇报时用中文；区分「已核实」「推断」「未验证」，写明跑过什么命令、看到什么输出。
本机**没有**酒馆/Luker 的安装目录（只有可选的 Luker 源码浅克隆），任何宿主行为结论都要标明验证来源。
