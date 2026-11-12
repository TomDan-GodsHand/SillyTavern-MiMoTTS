/**
 * MiMo TTS — 小米 MiMo 语音合成供应商（SillyTavern 第三方扩展）
 * v2.2.0：公开版（0.2.0）+ 自用完整版（1.4.x）+ 音色克隆 + 音色设计 + 自动音色设计
 *
 * 关于音频质量的要点（重要，勿轻易改动）：
 *   MiMo 的 /v1/chat/completions 在 stream:true 时，**每个 SSE 数据块都会自带一个
 *   MP3 元数据帧（Xing 头帧，以 "Xing" 标记）**。把多块拼起来就等于在音频中间插入
 *   了几十个空帧，播放时会每 ~0.3 秒"突"一下。
 *   因此：整段播放必须走 stream:false（返回单个完整 MP3，仅含 1 个 Xing 帧）。
 *   分块播放则改用 pcm16（无帧结构、可任意切割）并自行封装 WAV，避开该问题。
 *
 * 播放方式（play_mode）：
 *   whole   整段播放（默认，推荐）—— 非流式接口拿完整音频，只播一次，完全连贯。
 *   chunked 分块流式 —— 首音快，但酒馆每块都要"换音源+等 canplay"（0.3~0.5s），
 *                        块间必然有间断，仅作尝鲜。
 *
 * 传输方式（mode）：direct = 浏览器直连新加坡；relay = 经服务器本地中转。
 *
 * 音色克隆（voice clone）：
 *   model = mimo-v2.5-tts-voiceclone，audio.voice 传
 *   `data:<mime>;base64,<样本>`（≤10MB，仅 mp3/wav），文本必须放在 assistant 消息。
 *   官方明确：克隆不支持低延迟流式（只会在推理完成后一次性返回），因此克隆一律走
 *   非流式整段；克隆模型也不支持预置音色与音色设计。
 *   参考音频存在浏览器 IndexedDB（不塞进 settings.json，避免每次保存写几 MB）。
 *
 * 音色设计（voice design）：
 *   model = mimo-v2.5-tts-voicedesign，音色描述文本放 user 消息、正文放 assistant 消息，
 *   并且绝对不能传 audio.voice —— 实测带上它直接 400：
 *   {"error":{"code":"400","message":"Param Incorrect","param":"audio.voice is not supported
 *   for voice design model"}}。它也没有预置音色、没有低延迟流式（流式是"兼容模式"，
 *   推理完才一次性返回），所以和克隆一样走非流式整段。
 *   另外每次请求都会重新设计音色，同一描述两次结果不同（实测），要固定音色请改用克隆。
 *
 * 自动音色设计（配合 Luker 的「NPC 对话归属」）：
 *   宿主调 provider 是 generateTts(text, voiceId, voiceMapKey)：第三个参数带着说话人名
 *   （多音色模式下形如 `说书人 ("Quotes")`）。归属解析认出的 NPC 会被宿主写进 provider 的
 *   voiceMap，但值是 [Default Voice]（= 认出了这个人、还没给它配音色）。
 *   若用户开了「自动音色设计」，就用宿主已配好的归属解析连接 / 聊天补全预设
 *   （scripts/lib/iter-tool-calling.js 的 requestToolCallWithRetry）写一段音色描述，
 *   存成 `[设计] 名字` 后按 voice design 合成；任何一步失败都回落到默认音色，不打断朗读。
 *
 * 安装位置：data/<user>/extensions/mimo-tts/（在 git 之外，升级酒馆不受影响）
 */

import { getRequestHeaders, eventSource, event_types } from '../../../../script.js';
import { registerTtsProvider, saveTtsProviderSettings } from '../../tts/index.js';

const VERSION = '2.2.0';
const PROVIDER_NAME = 'MiMo';
const MIMO_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
const ST_RELAY_ROUTE = '/api/openai/custom/generate-voice';
const MODEL_PRESET = 'mimo-v2.5-tts';
const MODEL_CLONE = 'mimo-v2.5-tts-voiceclone';
const MODEL_DESIGN = 'mimo-v2.5-tts-voicedesign';
const BYTES_PER_SECOND = 48000; // pcm16 24kHz/16bit 单声道 = 48000 B/s
const PCM_SAMPLE_RATE = 24000;
const PREVIEW_TEXT = '你好，我是小米 MiMo 的语音合成，这是一段试听。';
const CLONE_PREFIX = 'clone:';            // 音色 ID 前缀，避免与预置音色重名
const CLONE_DISPLAY_PREFIX = '[克隆] ';    // 下拉框里显示的名字
const DESIGN_PREFIX = 'design:';          // 设计音色的音色 ID 前缀
const DESIGN_DISPLAY_PREFIX = '[设计] ';   // 下拉框里显示的名字
const DESIGN_NAME_MAX = 40;               // 与克隆音色取同一个上限
const DESIGN_PROMPT_MAX = 1000;           // 官方建议 1~4 句，这里给足余量
// 【自动音色设计】宿主（Luker）的约定：没配过音色的说话人，在 provider voiceMap 里的值是 '[Default Voice]'
const DEFAULT_VOICE_MARKER = '[Default Voice]';
// 多音色模式下 voiceMapKey 会带段类型后缀，取说话人名时要先去掉
const MULTI_VOICE_KEY_SUFFIXES = [' ("Quotes")', ' (*Text inside asterisks*)', ' (Other text)'];
const AUTO_DESIGN_TOOL_NAME = 'report_voice_description';
const CLONE_MAX_B64 = 10 * 1024 * 1024;   // 官方上限：base64 ≤ 10MB
const CLONE_WARN_BYTES = 2 * 1024 * 1024; // 超过则提示（每次请求都要重传）
const IDB_NAME = 'mimo-tts-clones';
const IDB_STORE = 'clones';

// ----------------------------------------------------------------------
//  在途请求的取消（重要）
//  酒馆的 resetTtsPlayback() 只会清空队列，**不会通知供应商取消已发出的请求**。
//  而 MiMo 整段合成要 5~10 秒，若不取消，"过期"的音频会在用户切换消息之后才
//  落地播放 —— 表现为：点了另一条没反应 / 两条一起读 / 播起来没完。
//  这里采用「新的覆盖旧的」策略：新请求一来就中止上一个。
// ----------------------------------------------------------------------

/** @type {AbortController|null} */
let activeController = null;

function isAbortError(error) {
    return !!error && (error.name === 'AbortError' || /aborted|abort/i.test(String(error.message || '')));
}

/**
 * 判断清洗后的文本是否「有可朗读的内容」。
 * MiMo 对空串 / 纯换行 / 纯标点会直接返回 HTTP 500（实测），必须提前拦下来，
 * 否则用户看到的就是一坨 {"error":{"code":"500"...}}。
 */
function hasSpeakableText(text) {
    const s = String(text ?? '').trim();
    if (!s) {
        return false;
    }
    // 去掉所有空白 / 标点 / 符号后还剩东西，才算可朗读
    return s.replace(/[\s\p{P}\p{S}]/gu, '').length > 0;
}

/** 开始一次生成：中止上一个在途请求，返回新的 signal */
function beginGeneration() {
    abortActiveGeneration();
    activeController = new AbortController();
    return activeController.signal;
}

/** 中止当前在途生成（停止播放 / 切换消息 / 卸载供应商时调用） */
function abortActiveGeneration() {
    if (activeController) {
        try {
            activeController.abort();
        } catch {
            /* ignore */
        }
        activeController = null;
    }
}

function toast(kind, message) {
    try {
        if (typeof toastr !== 'undefined' && typeof toastr[kind] === 'function') {
            toastr[kind](message, 'MiMo TTS', { timeOut: 3500 });
            return;
        }
    } catch {
        /* ignore */
    }
    console.info(`[MiMo TTS] ${message}`);
}

/** base64 → Uint8Array */
function base64ToBytes(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

/** 把若干 Uint8Array 拼成一个 */
function concatBytes(list) {
    let total = 0;
    for (const c of list) {
        total += c.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of list) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}

/** 给裸 PCM16 加上 WAV 头（24kHz / 16bit / 单声道） */
function pcm16ToWav(pcm) {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeStr = (off, s) => {
        for (let i = 0; i < s.length; i++) {
            view.setUint8(off + i, s.charCodeAt(i));
        }
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // 单声道
    view.setUint32(24, PCM_SAMPLE_RATE, true);
    view.setUint32(28, PCM_SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, pcm.length, true);

    const out = new Uint8Array(44 + pcm.length);
    out.set(new Uint8Array(header), 0);
    out.set(pcm, 44);
    return out;
}

// ----------------------------------------------------------------------
//  克隆音色的参考音频存储（IndexedDB）
//  为什么不放 settings.json：参考音频 base64 动辄 1~10MB，而酒馆每次改动都会把
//  整份设置写盘；塞进去会让保存变慢、备份变大、还可能超出服务端请求体限制。
//  settings 里只留元数据（名字/mime/大小），音频本体存在浏览器 IndexedDB。
// ----------------------------------------------------------------------

function idbOpen() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('当前环境不支持 IndexedDB，无法保存参考音频'));
            return;
        }
        const request = indexedDB.open(IDB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'name' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function cloneGet(name) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const request = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(name);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

async function clonePut(record) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

async function cloneDelete(name) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(name);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/** File → 纯 base64（不带 data: 前缀） */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error('读取音频文件失败'));
        reader.readAsDataURL(file);
    });
}

/** 归一化参考音频的 MIME（官方只认 audio/mpeg 与 audio/wav） */
function normalizeAudioMime(file) {
    const type = String(file?.type || '').toLowerCase();
    const name = String(file?.name || '').toLowerCase();
    if (type === 'audio/mpeg' || type === 'audio/mp3' || type === 'audio/mpeg3') {
        return 'audio/mpeg';
    }
    if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave') {
        return 'audio/wav';
    }
    if (name.endsWith('.mp3')) {
        return 'audio/mpeg';
    }
    if (name.endsWith('.wav')) {
        return 'audio/wav';
    }
    return '';
}

function bytesToHuman(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 KB';
    }
    if (bytes >= 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export class MiMoTtsProvider {
    settings;
    voices = [];
    separator = '。';

    audioElement = document.createElement('audio');

    defaultSettings = {
        voiceMap: {},
        mode: 'direct',
        api_key: '',
        model: MODEL_PRESET,
        // whole = 整段播放（干净、连贯）；chunked = 分块流式（首音快但有间断）
        play_mode: 'whole',
        // 仅 chunked 模式有效：每块攒够多久才抛给播放器
        chunk_seconds: 8,
        // 分段流水线：长文本自动按句切分、逐批请求、边到边播（首音更快）。
        // 用于替代酒馆的「按段朗读」——后者会让清洗变为逐行，跨行正则失效。
        pipeline: true,
        pipeline_first: 20,   // 首批字数（越小首音越快）
        pipeline_max: 120,    // 后续每批上限（越大卡顿越少）
        style: '',
        voices: ['茉莉', '冰糖', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'],
        // 克隆音色元数据：[{ name, mime, bytes, createdAt }]，音频本体在 IndexedDB
        clones: [],
        // 设计音色：[{ name, prompt, auto? }]。描述只有几十字，直接进 settings.json（不像克隆要存音频）
        designs: [],
        // 自动音色设计：归属解析认出、但还没配音色的 NPC，自动写描述并用设计音色合成
        auto_design: false,
        // 中转地址留空，由用户自己填（不再写死某台机器的内网地址）
        relay_endpoint: '',
    };

    get settingsHtml() {
        return `
        <div class="mimo-tts-settings">
            <label for="mimo_play_mode">播放方式：</label>
            <select id="mimo_play_mode" class="text_pole">
                <option value="whole">整段播放（推荐：声音完整连贯，等待稍长）</option>
                <option value="chunked">分块流式（首音快，但会有间断）</option>
            </select>
            <small>
                <b>推荐用"整段播放"。</b>酒馆全程只用一个播放器，每换一次音频源就要重新解码等待
                0.3~0.5 秒，所以只要分成多块就必然一顿一顿，"分块流式"无法做到连贯。<br>
                整段播放走非流式接口拿完整音频，只播一次，因此完全顺滑；
                代价是首音要等 MiMo 把整段合成完（约 50 毫秒/字，200 字约 10 秒）。
            </small>

            <label for="mimo_chunk_seconds">攒包阈值（秒，仅"分块流式"有效）：</label>
            <input id="mimo_chunk_seconds" type="number" class="text_pole" min="1" max="60" step="1"/>

            <label class="checkbox_label">
                <input type="checkbox" id="mimo_pipeline"/>
                <span>分段流水线（长文本自动分句，首音更快）</span>
            </label>
            <small>
                酒馆的「按段朗读」会让文本清洗变成<b>逐行</b>执行，跨行正则因此失效
                （标签、元数据会被念出来）。要正确过滤，需把「按段朗读」<b>关掉</b>；
                关掉后由本扩展自己把长文本按句切分、逐批请求、边到边播，首音仍只要 1~2 秒。
            </small>

            <label for="mimo_pipeline_first">首批字数 / 后续每批上限：</label>
            <div class="flex-container alignItemsCenter flexGap5">
                <input id="mimo_pipeline_first" type="number" class="text_pole" min="5" max="200" step="5"/>
                <input id="mimo_pipeline_max" type="number" class="text_pole" min="20" max="500" step="10"/>
            </div>

            <hr>

            <label for="mimo_mode">传输方式：</label>
            <select id="mimo_mode" class="text_pole">
                <option value="direct">直连（浏览器 → 新加坡）</option>
                <option value="relay">经服务器中转（备用）</option>
            </select>

            <label for="mimo_api_key">API Key（直连模式用）：</label>
            <input id="mimo_api_key" type="password" class="text_pole" maxlength="200" placeholder="sk-..." autocomplete="off"/>

            <label for="mimo_model">模型：</label>
            <input id="mimo_model" type="text" class="text_pole" maxlength="100"/>

            <label for="mimo_voices">音色列表（逗号分隔）：</label>
            <input id="mimo_voices" type="text" class="text_pole" maxlength="500"/>

            <label for="mimo_style">风格指令（可留空）：</label>
            <input id="mimo_style" type="text" class="text_pole" maxlength="500" placeholder="例如：用轻快上扬的语调，语速稍快"/>

            <label for="mimo_relay_endpoint">中转地址（中转模式用，由服务器发起请求）：</label>
            <input id="mimo_relay_endpoint" type="text" class="text_pole" maxlength="500" placeholder="留空 = 不启用中转；例如 http://你的中转服务:端口/v1/audio/speech"/>

            <hr>

            <label>音色设计（mimo-v2.5-tts-voicedesign）：</label>
            <small>
                用一段自然语言描述设计音色，<b>不需要参考音频</b>。官方建议 1~4 句，覆盖
                性别年龄、音色质感、情绪语气、语速节奏；避免自相矛盾的特征，也不要写混响 / EQ 这类后期处理词。<br>
                音色设计<b>只能直连</b>（中转接口是 OpenAI 的 /v1/audio/speech，没有承载音色描述的字段），
                也<b>没有低延迟流式</b>，所以和克隆一样走整段播放。<br>
                注意：<b>同样的描述每次生成的结果都不一样</b>（实测）。想要稳定不变的音色，
                先用它生成一段满意的音频，再把那段音频当"音色克隆"上传。
            </small>
            <div class="flex-container alignItemsCenter flexGap5">
                <input type="text" id="mimo_design_name" class="text_pole" maxlength="40" placeholder="音色名字，例如：说书人"/>
            </div>
            <textarea id="mimo_design_prompt" class="text_pole" rows="3" maxlength="1000" placeholder="音色描述，例如：低沉沙哑的中年男性，语速缓慢，带北方口音，像评书先生讲故事"></textarea>
            <div class="flex-container alignItemsCenter flexGap5">
                <button id="mimo_design_add" class="menu_button" type="button">添加设计音色</button>
                <small>（上方"风格指令"非空时会一并作为语气要求交给模型）</small>
            </div>
            <div id="mimo_design_list" class="mimo-design-list" style="margin:8px 0;display:flex;flex-direction:column;gap:6px"></div>

            <hr style="opacity:.3">

            <label class="checkbox_label">
                <input type="checkbox" id="mimo_auto_design"/>
                <span>自动音色设计（归属解析认出、但还没配音色的角色）</span>
            </label>
            <small>
                需要宿主（Luker）的归属解析能力：<b>复用你已选的「归属解析 API 连接 / 聊天补全预设」，不用在这里再填 key</b>。
                当某个说话人在 voiceMap 里仍是 <code>[Default Voice]</code> 时，自动让模型写一段音色描述，
                存成 <code>[设计] 名字</code> 后用它合成（列表里标 <b>AI</b>，可改可删）。
                任一步失败都会自动回落到默认音色，不会打断朗读。原版酒馆没有这套机制，勾了也不生效。
            </small>

            <hr>

            <label>音色克隆（mimo-v2.5-tts-voiceclone）：</label>
            <small>
                上传一段 <b>5~15 秒清晰人声</b>（mp3 / wav，base64 后 ≤10MB）。
                克隆<b>只能直连</b>（中转接口只认预置音色 ID）。官方对克隆的流式是"降级兼容模式"：
                整段推理完才一次性返回，拿不到边生成边播，所以首音比预置音色慢是必然的。<br>
                本扩展用<b>分段流水线</b>抢首音（第一批先播，后面的边合成边播），代价是每批都会重传一次参考音频，
                因此样本越短越好（10 秒 mp3 约 100KB，完全可接受）。<br>
                参考音频保存在浏览器本地（IndexedDB），不会写进 settings.json，也不会随设置在设备间同步。
            </small>
            <div class="flex-container alignItemsCenter flexGap5">
                <input type="file" id="mimo_clone_file" accept=".mp3,.wav,audio/mpeg,audio/wav" />
                <input type="text" id="mimo_clone_name" class="text_pole" maxlength="40" placeholder="音色名字，例如：孟非"/>
                <button id="mimo_clone_add" class="menu_button" type="button">添加克隆音色</button>
            </div>
            <div id="mimo_clone_list" class="mimo-clone-list" style="margin:8px 0;display:flex;flex-direction:column;gap:6px"></div>

            <small class="mimo-hint">
                直连走你的浏览器 → 新加坡，服务器完全不参与；若直连不可用，把"传输方式"改成"经服务器中转"即可。<br>
                音色与角色映射沿用酒馆的 Voice Map，无需在此重复设置。
            </small>
            <div id="mimo_save_state" class="mimo-save-state" style="margin-top:6px;font-size:12px;opacity:.65"></div>
        </div>`;
    }

    constructor() {
        this.handler = async function (/** @type {string} */ key) {
            if (key !== 'api_key_custom_openai_tts') {
                return;
            }
        }.bind(this);
    }

    dispose() {
        // 供应商被卸载/切换时，中止仍在途的生成，避免音频迟到落地
        abortActiveGeneration();
    }

    async loadSettings(settings) {
        this.settings = Object.assign({}, this.defaultSettings);
        this.settings.voiceMap = Object.assign({}, (settings && settings.voiceMap) || {});

        for (const key in settings) {
            if (key in this.defaultSettings && key !== 'voiceMap') {
                this.settings[key] = settings[key];
            } else if (!(key in this.defaultSettings)) {
                console.warn(`[MiMo TTS] 忽略未知设置项: ${key}`);
            }
        }

        if (!Array.isArray(this.settings.voices)) {
            this.settings.voices = [...this.defaultSettings.voices];
        }
        if (!Array.isArray(this.settings.clones)) {
            this.settings.clones = [];
        }
        this.settings.clones = this.settings.clones
            .filter(c => c && typeof c.name === 'string' && c.name.trim().length > 0)
            .map(c => ({ name: c.name, mime: c.mime || 'audio/wav', bytes: Number(c.bytes) || 0, createdAt: Number(c.createdAt) || 0 }));
        if (!Array.isArray(this.settings.designs)) {
            this.settings.designs = [];
        }
        const rawDesigns = this.settings.designs;
        this.settings.designs = this.settings.designs
            .filter(d => d && typeof d.name === 'string' && d.name.trim().length > 0)
            .map(d => (d.auto
                ? { name: String(d.name).trim(), prompt: String(d.prompt || '').trim(), auto: true }
                : { name: String(d.name).trim(), prompt: String(d.prompt || '').trim() }))
            .filter(d => d.prompt.length > 0);
        if (this.settings.designs.length !== rawDesigns.length) {
            console.warn(`[MiMo TTS] 有 ${rawDesigns.length - this.settings.designs.length} 个设计音色缺少描述，已忽略（请在面板里补上描述或删除）`);
        }

        $('#mimo_play_mode').val(this.settings.play_mode);
        $('#mimo_chunk_seconds').val(this.settings.chunk_seconds);
        $('#mimo_pipeline').prop('checked', !!this.settings.pipeline);
        $('#mimo_pipeline_first').val(this.settings.pipeline_first);
        $('#mimo_pipeline_max').val(this.settings.pipeline_max);
        $('#mimo_mode').val(this.settings.mode);
        $('#mimo_api_key').val(this.settings.api_key);
        $('#mimo_model').val(this.settings.model);
        $('#mimo_voices').val(this.settings.voices.join(','));
        $('#mimo_style').val(this.settings.style);
        $('#mimo_relay_endpoint').val(this.settings.relay_endpoint);
        $('#mimo_auto_design').prop('checked', !!this.settings.auto_design);

        const bind = (selector, handler) => {
            $(selector).off('input change').on('input change', handler);
        };

        bind('#mimo_play_mode', () => this.onSettingsChange());
        bind('#mimo_chunk_seconds', () => this.onSettingsChange());
        bind('#mimo_pipeline', () => this.onSettingsChange());
        bind('#mimo_pipeline_first', () => this.onSettingsChange());
        bind('#mimo_pipeline_max', () => this.onSettingsChange());
        bind('#mimo_mode', () => this.onSettingsChange());
        bind('#mimo_api_key', () => this.onSettingsChange());
        bind('#mimo_model', () => this.onSettingsChange());
        bind('#mimo_voices', () => this.onSettingsChange());
        bind('#mimo_style', () => this.onSettingsChange());
        bind('#mimo_relay_endpoint', () => this.onSettingsChange());
        bind('#mimo_auto_design', () => this.onSettingsChange());

        $('#mimo_clone_add').off('click').on('click', (event) => { event.preventDefault(); event.stopPropagation(); this.onCloneAdd(); });
        $('#mimo_clone_list').off('click').on('click', '[data-clone-action]', (event) => {
            const el = event.currentTarget;
            const name = el?.getAttribute('data-clone-name') || '';
            event.preventDefault();
            event.stopPropagation();
            const action = el?.getAttribute('data-clone-action');
            if (!name) {
                return;
            }
            if (action === 'preview') {
                this.previewTtsVoice(`${CLONE_PREFIX}${name}`).catch(error => toast('error', `试听失败：${error?.message || error}`));
            } else if (action === 'delete') {
                this.onCloneDelete(name);
            }
        });

        $('#mimo_design_add').off('click').on('click', (event) => { event.preventDefault(); event.stopPropagation(); this.onDesignAdd(); });
        $('#mimo_design_list').off('click').on('click', '[data-design-action]', (event) => {
            const el = event.currentTarget;
            const name = el?.getAttribute('data-design-name') || '';
            event.preventDefault();
            event.stopPropagation();
            const action = el?.getAttribute('data-design-action');
            if (!name) {
                return;
            }
            if (action === 'preview') {
                this.previewTtsVoice(`${DESIGN_PREFIX}${name}`).catch(error => toast('error', `试听失败：${error?.message || error}`));
            } else if (action === 'delete') {
                this.onDesignDelete(name);
            }
        });

        this.renderCloneList();
        this.renderDesignList();
        await this.checkReady();

        console.info(`[MiMo TTS] v${VERSION} 设置已加载：${this.settings.mode} / ${this.settings.play_mode} / 克隆音色 ${this.settings.clones.length} 个 / 设计音色 ${this.settings.designs.length} 个`);
    }

    onSettingsChange() {
        this.settings.play_mode = String($('#mimo_play_mode').val() || 'whole');
        const chunkSeconds = Number($('#mimo_chunk_seconds').val());
        this.settings.chunk_seconds = Number.isFinite(chunkSeconds) ? Math.min(60, Math.max(1, chunkSeconds)) : 8;
        this.settings.pipeline = !!$('#mimo_pipeline').prop('checked');
        const pf = Number($('#mimo_pipeline_first').val());
        this.settings.pipeline_first = Number.isFinite(pf) ? Math.min(200, Math.max(5, pf)) : 20;
        const pm = Number($('#mimo_pipeline_max').val());
        this.settings.pipeline_max = Number.isFinite(pm) ? Math.min(500, Math.max(20, pm)) : 120;
        this.settings.mode = String($('#mimo_mode').val() || 'direct');
        this.settings.api_key = String($('#mimo_api_key').val() || '');
        this.settings.model = String($('#mimo_model').val() || MODEL_PRESET);
        this.settings.voices = String($('#mimo_voices').val() || '')
            .split(',')
            .map(v => v.trim())
            .filter(v => v.length > 0);
        // 预置音色名如果占用了本扩展的保留前缀，会被前缀分支当成克隆/设计音色劫持：
        // 轻则请求失败，重则静默换成另一个音色。这里只提醒，不改用户配置。
        const reservedNames = this.settings.voices.filter(v => v.startsWith(CLONE_PREFIX) || v.startsWith(CLONE_DISPLAY_PREFIX)
            || v.startsWith(DESIGN_PREFIX) || v.startsWith(DESIGN_DISPLAY_PREFIX));
        if (reservedNames.length > 0) {
            console.warn(`[MiMo TTS] 音色列表里有名字占用了保留前缀（${reservedNames.join('、')}），它们会被当作克隆/设计音色处理，建议改名`);
        }
        this.settings.style = String($('#mimo_style').val() || '');
        this.settings.relay_endpoint = String($('#mimo_relay_endpoint').val() || '').trim();
        this.settings.auto_design = !!$('#mimo_auto_design').prop('checked');
        // clones 由增删按钮维护，这里不动它
        saveTtsProviderSettings();
        this.markSaved();
    }

    /** 让"到底存没存"这件事可见：酒馆是内存态整体回写 + 1s 防抖 */
    markSaved() {
        const el = document.getElementById('mimo_save_state');
        if (!el) {
            return;
        }
        const now = new Date();
        el.textContent = `设置已保存 ${now.toLocaleTimeString('zh-CN', { hour12: false })}（酒馆防抖 1 秒）`;
    }

    renderCloneList() {
        const host = document.getElementById('mimo_clone_list');
        if (!host) {
            return;
        }
        const clones = Array.isArray(this.settings?.clones) ? this.settings.clones : [];
        if (clones.length === 0) {
            host.innerHTML = `<small class="mimo-clone-empty">还没有克隆音色。上传参考音频并起个名字即可。</small>`;
            return;
        }
        host.innerHTML = clones.map(c => `
            <div class="mimo-clone-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span class="mimo-clone-name" style="min-width:8em">${CLONE_DISPLAY_PREFIX}${escapeHtml(c.name)}</span>
                <span class="mimo-clone-meta" style="font-size:12px;opacity:.65">${c.mime === 'audio/mpeg' ? 'mp3' : 'wav'} · ${bytesToHuman(c.bytes)}</span>
                <button class="menu_button" type="button" data-clone-action="preview" data-clone-name="${escapeAttr(c.name)}">试听</button>
                <button class="menu_button" type="button" data-clone-action="delete" data-clone-name="${escapeAttr(c.name)}">删除</button>
            </div>`).join('');
    }

    async onCloneAdd() {
        const fileInput = document.getElementById('mimo_clone_file');
        const nameInput = document.getElementById('mimo_clone_name');
        const file = fileInput?.files?.[0];
        const name = String(nameInput?.value || '').trim();

        if (!file) {
            toast('warning', '先选一段参考音频（mp3 / wav）');
            document.getElementById('mimo_clone_file')?.click();
            return;
        }
        if (!name) {
            toast('warning', '给这个音色起个名字（会显示成 [克隆] 名字）');
            return;
        }
        if (name.length > 40) {
            toast('warning', '名字最多 40 个字');
            return;
        }
        const mime = normalizeAudioMime(file);
        if (!mime) {
            toast('error', '只支持 mp3 / wav 格式的参考音频');
            return;
        }

        try {
            const b64 = await fileToBase64(file);
            if (b64.length > CLONE_MAX_B64) {
                toast('error', `参考音频太大（base64 ${bytesToHuman(b64.length)}），官方上限 10MB`);
                return;
            }
            if (b64.length > CLONE_WARN_BYTES) {
                toast('info', `样本较大（${bytesToHuman(b64.length)}），每次合成都会重传一遍，建议截短到 15 秒内`);
            }

            await clonePut({ name, mime, b64, createdAt: Date.now() });

            const meta = { name, mime, bytes: Math.round(b64.length * 0.75), createdAt: Date.now() };
            this.settings.clones = (this.settings.clones || []).filter(c => c.name !== name).concat(meta);
            this.settings.clones.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
            this.voices = await this.fetchTtsVoiceObjects();
            saveTtsProviderSettings();
            this.markSaved();
            this.renderCloneList();

            if (fileInput) {
                fileInput.value = '';
            }
            if (nameInput) {
                nameInput.value = '';
            }
            toast('success', `已添加克隆音色：${name}`);
        } catch (error) {
            toast('error', `添加失败：${error?.message || error}`);
        }
    }

    async onCloneDelete(name) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
            && !window.confirm(`删除克隆音色「${name}」？参考音频会从浏览器里一并删除。`)) {
            return;
        }
        try {
            await cloneDelete(name);
        } catch (error) {
            console.warn('[MiMo TTS] 删除参考音频失败（元数据仍会移除）', error);
        }
        this.settings.clones = (this.settings.clones || []).filter(c => c.name !== name);
        this.voices = await this.fetchTtsVoiceObjects();
        saveTtsProviderSettings();
        this.markSaved();
        this.renderCloneList();
        toast('success', `已删除克隆音色：${name}`);
    }

    // ------------------------------------------------------------------
    //  音色设计（mimo-v2.5-tts-voicedesign）
    //  与克隆的区别：不用上传音频，一段描述文本就是"音色"。
    //  代价：模型每次请求都重新设计，同一描述两次结果不同（实测），
    //  所以它适合"把音色定下方向"，要长期稳定的音色请用它生成样本后改用克隆。
    // ------------------------------------------------------------------

    renderDesignList() {
        const host = document.getElementById('mimo_design_list');
        if (!host) {
            return;
        }
        const designs = Array.isArray(this.settings?.designs) ? this.settings.designs : [];
        if (designs.length === 0) {
            host.innerHTML = `<small class="mimo-design-empty">还没有设计音色。写一段音色描述并起个名字即可。</small>`;
            return;
        }
        host.innerHTML = designs.map(d => `
            <div class="mimo-design-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span class="mimo-design-name" style="min-width:8em">${DESIGN_DISPLAY_PREFIX}${escapeHtml(d.name)}${d.auto ? ' <small style="opacity:.6">AI</small>' : ''}</span>
                <span class="mimo-design-prompt" style="font-size:12px;opacity:.65;flex:1 1 12em;min-width:8em">${escapeHtml(designPreview(d.prompt))}</span>
                <button class="menu_button" type="button" data-design-action="preview" data-design-name="${escapeAttr(d.name)}">试听</button>
                <button class="menu_button" type="button" data-design-action="delete" data-design-name="${escapeAttr(d.name)}">删除</button>
            </div>`).join('');
    }

    async onDesignAdd() {
        const nameInput = document.getElementById('mimo_design_name');
        const promptInput = document.getElementById('mimo_design_prompt');
        const name = String(nameInput?.value || '').trim();
        const prompt = String(promptInput?.value || '').trim();

        if (!name) {
            toast('warning', '给这个设计音色起个名字（会显示成 [设计] 名字）');
            return;
        }
        if (name.length > DESIGN_NAME_MAX) {
            toast('warning', `名字最多 ${DESIGN_NAME_MAX} 个字`);
            return;
        }
        if (!prompt) {
            toast('warning', '音色描述不能为空：写 1~4 句，覆盖性别年龄、音色质感、语气与语速');
            return;
        }
        if (prompt.length > DESIGN_PROMPT_MAX) {
            toast('warning', `音色描述最多 ${DESIGN_PROMPT_MAX} 个字，1~4 句就够`);
            return;
        }

        this.settings.designs = (this.settings.designs || []).filter(d => d.name !== name).concat({ name, prompt });
        this.settings.designs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        this.voices = await this.fetchTtsVoiceObjects();
        saveTtsProviderSettings();
        this.markSaved();
        this.renderDesignList();

        if (nameInput) {
            nameInput.value = '';
        }
        if (promptInput) {
            promptInput.value = '';
        }
        toast('success', `已添加设计音色：${name}（同一描述每次会有差异，想固定请改用克隆）`);
    }

    async onDesignDelete(name) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
            && !window.confirm(`删除设计音色「${name}」？（描述文本会一并删除）`)) {
            return;
        }
        this.settings.designs = (this.settings.designs || []).filter(d => d.name !== name);
        this.voices = await this.fetchTtsVoiceObjects();
        saveTtsProviderSettings();
        this.markSaved();
        this.renderDesignList();
        toast('success', `已删除设计音色：${name}`);
    }

    /** 组装 voicedesign 的 user 消息：音色描述 +（可选）全局风格指令，官方允许两者同放 user */
    buildDesignPrompt(prompt) {
        const style = String(this.settings.style || '').trim();
        return style ? `${prompt}\n风格指令：${style}` : prompt;
    }

    async checkReady() {
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async onRefreshClick() {
        this.voices = await this.fetchTtsVoiceObjects();
        this.renderCloneList();
        this.renderDesignList();
    }

    async getVoice(voiceName) {
        if (this.voices.length === 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }
        const match = this.voices.find(v => v.name === voiceName || v.voice_id === voiceName);
        if (!match) {
            throw `TTS Voice name ${voiceName} not found`;
        }
        return match;
    }

    async fetchTtsVoiceObjects() {
        const preset = (this.settings.voices || []).map(v => ({ name: v, voice_id: v, lang: 'zh-CN' }));
        const clones = (this.settings.clones || []).map(c => ({
            name: `${CLONE_DISPLAY_PREFIX}${c.name}`,
            voice_id: `${CLONE_PREFIX}${c.name}`,
            lang: 'zh-CN',
        }));
        const designs = (this.settings.designs || []).map(d => ({
            name: `${DESIGN_DISPLAY_PREFIX}${d.name}`,
            voice_id: `${DESIGN_PREFIX}${d.name}`,
            lang: 'zh-CN',
        }));
        return preset.concat(clones).concat(designs);
    }

    /** 酒馆的 voicemap 里存的是显示名，generateTts 收到的是 voice_id —— 两种都接住 */
    resolveVoiceId(input) {
        const raw = String(input ?? '').trim();
        if (!raw) {
            return raw;
        }
        if (raw.startsWith(CLONE_PREFIX) || raw.startsWith(CLONE_DISPLAY_PREFIX)) {
            return raw.startsWith(CLONE_PREFIX) ? raw : `${CLONE_PREFIX}${raw.slice(CLONE_DISPLAY_PREFIX.length)}`;
        }
        if (raw.startsWith(DESIGN_PREFIX) || raw.startsWith(DESIGN_DISPLAY_PREFIX)) {
            return raw.startsWith(DESIGN_PREFIX) ? raw : `${DESIGN_PREFIX}${raw.slice(DESIGN_DISPLAY_PREFIX.length)}`;
        }
        const match = this.voices.find(v => v.name === raw || v.voice_id === raw);
        return match ? match.voice_id : raw;
    }

    isCloneVoice(voiceId) {
        return String(voiceId || '').startsWith(CLONE_PREFIX);
    }

    isDesignVoice(voiceId) {
        return String(voiceId || '').startsWith(DESIGN_PREFIX);
    }

    // ------------------------------------------------------------------
    //  合成入口
    // ------------------------------------------------------------------

    /**
     * @param {string} text 要朗读的文本（宿主已切好的片段）
     * @param {string} voiceId 宿主按 voiceMap 选出的音色
     * @param {string} [voiceMapKey] 宿主额外传的 voiceMap 键：带说话人名（多音色模式下带段类型后缀）
     */
    generateTts(text, voiceId, voiceMapKey) {
        // 【防护】白名单式正则可能把「整条都是元数据块」的消息删空
        // （例如整条只有 <phone_module> 或 <chat_history>），
        // 而 MiMo 对空内容会返回 HTTP 500 —— 这里提前拦下，别把 500 抛给用户。
        if (!hasSpeakableText(text)) {
            console.info('[MiMo TTS] 这条消息清洗后没有可朗读的文字（可能整条都是元数据块），已跳过。清洗后内容:', JSON.stringify(text));
            toast('info', '这条消息没有可朗读的文字（内容都是元数据块）');
            return (async function* () {})();
        }

        const resolved = this.resolveVoiceId(voiceId);
        // 新请求覆盖旧请求：中止上一个仍在途的生成
        const signal = beginGeneration();

        // 【自动音色设计】只在「宿主认出了这个说话人、但它还没有自己的音色」时接管；
        // 接管失败会回落到宿主给的默认音色。判断依据见 resolveAutoDesignSpeaker。
        const autoSpeaker = this.resolveAutoDesignSpeaker(voiceMapKey);
        if (autoSpeaker) {
            return this.autoDesignTts(text, autoSpeaker, resolved, signal);
        }

        // 克隆：官方把流式降级成"推理完成后一次性返回"，拿不到边生成边播。
        // 只能靠分段流水线抢首音：第一批先合成先播，后面的边合成边播。
        // 代价是每批请求都会重传一次参考音频（10 秒 mp3 约 100KB，可接受）。
        if (this.isCloneVoice(resolved)) {
            return this.wholeTts(text, resolved, signal);
        }
        // 音色设计：不能分批 —— 每批请求都会重新设计一次音色，同一条消息里分批会让音色中途漂移。
        // 所以用 wholeTts 的 single 逃生口整段一次合成（代价是长文本首音更慢，但音色统一）。
        if (this.isDesignVoice(resolved)) {
            return this.wholeTts(text, resolved, signal, { single: true });
        }
        if (this.settings.play_mode === 'chunked' && this.settings.mode === 'direct') {
            return this.chunkedTts(text, resolved, signal);
        }
        return this.wholeTts(text, resolved, signal);
    }

    // ------------------------------------------------------------------
    //  自动音色设计（配合 Luker 的「NPC 对话归属」）
    //  宿主调 provider 是 generateTts(text, voiceId, voiceMapKey)，第三个参数带说话人名；
    //  归属解析认出的 NPC 会被写进 provider voiceMap，但值是 [Default Voice]（还没配音色）。
    //  这里补上「没音色 → 生成描述 → 用设计音色合成」，失败一律回落到默认音色。
    // ------------------------------------------------------------------

    /** 取宿主上下文；原版酒馆没有 getContext 就返回 null */
    getHostContext() {
        try {
            return globalThis.SillyTavern?.getContext?.() || null;
        } catch {
            return null;
        }
    }

    /** 实时读 provider voiceMap：宿主会往里加新 NPC，settings 里那份可能是旧的 */
    getLiveVoiceMap() {
        try {
            const live = this.getHostContext()?.extensionSettings?.tts?.[PROVIDER_NAME]?.voiceMap;
            if (live && typeof live === 'object') {
                return live;
            }
        } catch {
            /* ignore */
        }
        return this.settings?.voiceMap || {};
    }

    /** 这次调用要不要走自动音色设计？返回说话人名，或 null（交回宿主） */
    resolveAutoDesignSpeaker(voiceMapKey) {
        if (!this.settings?.auto_design) {
            return null;
        }
        const key = String(voiceMapKey || '').trim();
        if (!key) {
            return null;
        }
        if (this.getLiveVoiceMap()[key] !== DEFAULT_VOICE_MARKER) {
            return null; // 有专属音色 / 被禁用 / 未知 —— 都不接管
        }
        const speaker = extractSpeakerName(key);
        if (!speaker || speaker === DEFAULT_VOICE_MARKER) {
            return null;
        }
        return speaker;
    }

    /** 自动音色设计的合成入口；拿不到描述就用 fallbackVoiceId 正常合成 */
    async *autoDesignTts(text, speaker, fallbackVoiceId, signal) {
        const design = await this.ensureAutoDesign(speaker, text, signal);
        if (design) {
            yield* this.wholeTts(text, `${DESIGN_PREFIX}${speaker}`, signal, { single: true });
            return;
        }
        yield* this.wholeTts(text, fallbackVoiceId, signal);
    }

    /** 已有描述就直接用；没有就请模型写一段并落盘成设计音色 */
    async ensureAutoDesign(speaker, text, signal) {
        const existing = (this.settings.designs || []).find(d => d.name === speaker);
        if (existing && existing.prompt) {
            return existing;
        }
        try {
            const description = await this.requestVoiceDescription(speaker, text, signal);
            const design = { name: speaker, prompt: description, auto: true };
            this.settings.designs = (this.settings.designs || []).filter(d => d.name !== speaker).concat(design);
            this.settings.designs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
            this.voices = await this.fetchTtsVoiceObjects();
            saveTtsProviderSettings();
            this.renderDesignList();
            toast('info', `已为「${speaker}」自动生成音色描述`);
            return design;
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) {
                return null;
            }
            console.warn('[MiMo TTS] 自动音色设计失败，本次回落到默认音色：', error);
            toast('warning', `自动音色设计失败（${error?.message || error}），本次用默认音色朗读`);
            return null;
        }
    }

    /** 让宿主模型写音色描述：复用用户已配好的归属解析连接与聊天补全预设 */
    async requestVoiceDescription(speaker, text, signal) {
        const context = this.getHostContext();
        if (!context || typeof context.generateTask !== 'function') {
            throw new Error('当前宿主不提供 generateTask（自动音色设计需要 Luker 的归属解析能力）');
        }
        const helper = await loadToolCallHelper();
        const ttsSettings = context.extensionSettings?.tts || {};
        const args = await helper.requestToolCallWithRetry(context, { toolCallRetryMax: 1, rpmLimit: 0 }, {
            taskMessages: [
                { role: 'system', content: AUTO_DESIGN_SYSTEM_PROMPT },
                { role: 'user', content: buildAutoDesignUserPrompt(context, speaker, text) },
            ],
            apiPresetName: String(ttsSettings.npcAttributionApiPresetName || '').trim(),
            llmPresetName: String(ttsSettings.npcAttributionPresetName || '').trim(),
            functionName: AUTO_DESIGN_TOOL_NAME,
            functionDescription: 'Report a short voice-design description for this speaker.',
            parameters: {
                type: 'object',
                required: ['description'],
                properties: { description: { type: 'string' } },
                additionalProperties: false,
            },
            abortSignal: signal || null,
        });
        const description = String(args?.description || '').trim();
        if (!description) {
            throw new Error('模型没有返回音色描述');
        }
        return description.slice(0, DESIGN_PROMPT_MAX);
    }

    /**
     * 把长文本切成适合流水线的批次。
     * 首批小（首音快），之后按几何增长到上限——因为 MiMo 的生成速度约为播放速度的
     * 2.5 倍（实测约 54ms/字 vs 约 135ms/字），只要下一批不超上一批的 ~2.5 倍，
     * 播放就不会"断粮"（断供）。
     */
    splitIntoChunks(text) {
        const first = Math.max(5, Number(this.settings.pipeline_first) || 20);
        const max = Math.max(first, Number(this.settings.pipeline_max) || 120);
        const sentences = String(text).match(/[^。！？!?…；;\n]+[。！？!?…；;]*/g) || [String(text)];

        const chunks = [];
        let cur = '';
        let limit = first;

        for (const s of sentences) {
            if (cur && cur.length + s.length > limit) {
                chunks.push(cur);
                cur = s;
                limit = Math.min(max, Math.max(limit * 2, first));
            } else {
                cur += s;
            }
        }
        if (cur) {
            chunks.push(cur);
        }
        return chunks;
    }

    /**
     * 整段播放：逐批请求、边到边抛。
     * 每批都是一整段完整音频（内容不切碎），所以不会出现"突突突"；
     * 批与批之间会有一次换源开销（0.3~0.5s），落在句子边界上。
     * options.single = true 时不分批（音色设计用：它每次请求都重新设计音色，
     * 分批会让同一条消息里的音色漂移）。
     */
    async *wholeTts(text, voiceId, signal, options = {}) {
        const chunks = options.single || !this.settings.pipeline ? [text] : this.splitIntoChunks(text);

        for (let i = 0; i < chunks.length; i++) {
            if (signal?.aborted) {
                console.info('[MiMo TTS] 生成已取消（用户切换了消息或停止了播放）');
                return;
            }

            if (!hasSpeakableText(chunks[i])) {
                console.info(`[MiMo TTS] 第 ${i + 1} 批没有可朗读的内容，跳过`);
                continue;
            }

            let bytes;
            let contentType;
            try {
                ({ bytes, contentType } = await this.fetchWholeBytes(chunks[i], voiceId, signal));
            } catch (error) {
                if (signal?.aborted || isAbortError(error)) {
                    console.info('[MiMo TTS] 生成已取消（用户切换了消息或停止了播放）');
                    return;
                }
                if (i === 0) {
                    throw error; // 首批失败：直接把错误暴露给用户
                }
                console.warn(`[MiMo TTS] 第 ${i + 1} 批失败，跳过该批：`, error);
                continue;
            }

            yield new Response(bytes, {
                status: 200,
                headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.length) },
            });
        }
    }

    /**
     * 拿一整段音频，返回原始字节 + MIME。
     * 直连走非流式接口（单个完整 MP3，仅含 1 个 Xing 头帧，音频干净）；
     * 中转走酒馆转发的 5002 代理；克隆音色走 voiceclone 模型（只能直连）。
     */
    async fetchWholeBytes(text, voiceId, signal) {
        if (this.isCloneVoice(voiceId)) {
            return this.fetchCloneBytes(text, voiceId, signal);
        }
        if (this.isDesignVoice(voiceId)) {
            return this.fetchDesignBytes(text, voiceId, signal);
        }

        if (this.settings.mode === 'relay') {
            const endpoint = String(this.settings.relay_endpoint || '').trim();
            if (!endpoint) {
                throw new Error('已选择"经服务器中转"，但中转地址是空的。请在 MiMo 设置里填写中转地址，或改回直连。');
            }
            const response = await fetch(ST_RELAY_ROUTE, {
                method: 'POST',
                headers: getRequestHeaders(),
                signal,
                body: JSON.stringify({
                    provider_endpoint: endpoint,
                    model: resolvePresetModel(this.settings.model),
                    input: text,
                    voice: voiceId,
                    response_format: 'mp3',
                    speed: 1,
                }),
            });
            if (!response.ok) {
                throw new Error(`中转失败 HTTP ${response.status}: ${await response.text()}`);
            }
            const buf = await response.arrayBuffer();
            if (buf.byteLength === 0) {
                throw new Error('中转返回了空音频，请检查服务器上的代理是否在运行');
            }
            return {
                bytes: new Uint8Array(buf),
                contentType: response.headers.get('Content-Type') || 'audio/mpeg',
            };
        }

        let response = await this.postDirect(text, voiceId, false, 'mp3', signal);
        if (!response.ok && response.status >= 500) {
            // MiMo 服务端偶发 5xx（实测同一段文本可能一次 500、一次成功），自动重试一次
            console.warn(`[MiMo TTS] 服务端返回 ${response.status}，1 秒后重试一次`);
            await new Promise(r => setTimeout(r, 1000));
            response = await this.postDirect(text, voiceId, false, 'mp3', signal);
        }
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(
                response.status >= 500
                    ? `MiMo 服务端错误 ${response.status}（通常是 MiMo 那边的临时故障，稍后重试即可）。原始信息：${detail}`
                    : `MiMo HTTP ${response.status}: ${detail}`,
            );
        }
        const json = await response.json();
        const b64 = json?.choices?.[0]?.message?.audio?.data;
        if (!b64) {
            const detail = json?.base_resp?.status_msg || json?.error?.message || '返回体里没有音频数据';
            throw new Error(`MiMo 未返回音频：${detail}`);
        }
        const bytes = base64ToBytes(b64);
        if (bytes.length === 0) {
            throw new Error('MiMo 返回的音频数据为空，请检查模型名与音色是否正确');
        }
        return { bytes, contentType: 'audio/mpeg' };
    }

    /**
     * 克隆音色合成。
     * 官方契约：model=mimo-v2.5-tts-voiceclone，audio.voice 必须是
     * `data:<mime>;base64,<样本>`（≤10MB，仅 mp3/wav），文本放 assistant，
     * user 消息可选（用来传风格指令）。克隆不支持低延迟流式，故只用非流式。
     */
    async fetchCloneBytes(text, voiceId, signal) {
        if (this.settings.mode === 'relay') {
            throw new Error('克隆音色只支持直连：中转接口是 OpenAI 的 /v1/audio/speech，只能传预置音色 ID，塞不进参考音频。请把"传输方式"改回直连。');
        }

        const name = String(voiceId).slice(CLONE_PREFIX.length);
        const record = await cloneGet(name);
        if (!record || !record.b64) {
            throw new Error(`找不到克隆音色「${name}」的参考音频（可能换了浏览器或清了站点数据）。请重新上传一次样本。`);
        }

        const style = String(this.settings.style || '').trim();
        const messages = [];
        if (style) {
            messages.push({ role: 'user', content: style });
        }
        messages.push({ role: 'assistant', content: text });

        const payload = {
            model: MODEL_CLONE,
            messages,
            audio: {
                format: 'mp3',
                voice: `data:${record.mime || 'audio/wav'};base64,${record.b64}`,
            },
        };

        let response = await this.postJson(payload, signal);
        if (!response.ok && response.status >= 500) {
            console.warn(`[MiMo TTS] 克隆合成返回 ${response.status}，1 秒后重试一次`);
            await new Promise(r => setTimeout(r, 1000));
            response = await this.postJson(payload, signal);
        }
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`克隆合成失败 HTTP ${response.status}: ${detail}`);
        }

        const json = await response.json();
        const b64 = json?.choices?.[0]?.message?.audio?.data;
        if (!b64) {
            const detail = json?.base_resp?.status_msg || json?.error?.message || '返回体里没有音频数据';
            throw new Error(`克隆合成未返回音频：${detail}`);
        }
        const bytes = base64ToBytes(b64);
        if (bytes.length === 0) {
            throw new Error('克隆合成返回的音频为空，请换一段更清晰的参考音频再试');
        }
        return { bytes, contentType: 'audio/mpeg' };
    }

    /**
     * 音色设计合成（mimo-v2.5-tts-voicedesign）。
     * 官方契约：音色描述放 user 消息、正文放 assistant 消息，**不能传 audio.voice** ——
     * 实测带上它直接 400（audio.voice is not supported for voice design model）。
     * 它同样没有低延迟流式，所以也只走非流式整段；每批请求都会重新设计一次音色。
     */
    async fetchDesignBytes(text, voiceId, signal) {
        if (this.settings.mode === 'relay') {
            throw new Error('音色设计只支持直连：中转接口是 OpenAI 的 /v1/audio/speech，没有承载音色描述的字段。请把"传输方式"改回直连。');
        }

        const name = String(voiceId).slice(DESIGN_PREFIX.length);
        const design = (this.settings.designs || []).find(d => d.name === name);
        if (!design || !design.prompt) {
            throw new Error(`找不到设计音色「${name}」的描述（可能已被删除，或「音色列表」里有同名音色占用了 design: 前缀）。请在 MiMo 设置里补上描述或改名。`);
        }

        const payload = {
            model: MODEL_DESIGN,
            messages: [
                { role: 'user', content: this.buildDesignPrompt(design.prompt) },
                { role: 'assistant', content: text },
            ],
            // 这里绝对不能带 voice：voicedesign 不支持该字段，带了直接 400
            audio: { format: 'mp3' },
        };

        let response = await this.postJson(payload, signal);
        if (!response.ok && response.status >= 500) {
            console.warn(`[MiMo TTS] 音色设计合成返回 ${response.status}，1 秒后重试一次`);
            await new Promise(r => setTimeout(r, 1000));
            response = await this.postJson(payload, signal);
        }
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`音色设计合成失败 HTTP ${response.status}: ${detail}`);
        }

        const json = await response.json();
        const b64 = json?.choices?.[0]?.message?.audio?.data;
        if (!b64) {
            const detail = json?.base_resp?.status_msg || json?.error?.message || '返回体里没有音频数据';
            throw new Error(`音色设计未返回音频：${detail}`);
        }
        const bytes = base64ToBytes(b64);
        if (bytes.length === 0) {
            throw new Error('音色设计返回的音频为空，请把描述写得更具体一些再试');
        }
        return { bytes, contentType: 'audio/mpeg' };
    }

    /**
     * 分块流式：用 pcm16 传输（无帧结构，可安全切割）并自行封装 WAV，
     * 以避开 MiMo 流式块自带的 Xing 头帧造成的杂音。
     * 注意：块与块之间仍会有 0.3~0.5 秒间断，这是酒馆播放器决定的。
     */
    async *chunkedTts(text, voiceId, signal) {
        let response;
        try {
            response = await this.postDirect(text, voiceId, true, 'pcm16', signal);
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) {
                console.info('[MiMo TTS] 生成已取消（用户切换了消息或停止了播放）');
                return;
            }
            throw error;
        }
        if (!response.ok) {
            throw new Error(`MiMo HTTP ${response.status}: ${await response.text()}`);
        }

        const threshold = Math.max(48000, Number(this.settings.chunk_seconds || 8) * BYTES_PER_SECOND);
        let pending = [];
        let pendingBytes = 0;

        try {
            for await (const bytes of this.readSseAudio(response)) {
                pending.push(bytes);
                pendingBytes += bytes.length;
                if (pendingBytes >= threshold) {
                    const wav = this.takeWavChunk(pending);
                    pending = [];
                    pendingBytes = 0;
                    yield wav;
                }
            }
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) {
                console.info('[MiMo TTS] 生成已取消（用户切换了消息或停止了播放）');
                return;
            }
            throw error;
        }

        if (pendingBytes > 0) {
            yield this.takeWavChunk(pending);
        }
    }

    takeWavChunk(parts) {
        let pcm = concatBytes(parts);
        // 保证 16bit 采样对齐
        if (pcm.length % 2 !== 0) {
            pcm = pcm.subarray(0, pcm.length - 1);
        }
        const wav = pcm16ToWav(pcm);
        return new Response(wav, {
            status: 200,
            headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length) },
        });
    }

    /**
     * 解析 MiMo 的 SSE 流，逐段吐出原始音频字节。
     * 注意：网络分片可能把一行切断，所以要留残余缓冲。
     */
    async *readSseAudio(response) {
        if (!response.body) {
            throw new Error('当前环境不支持流式读取（response.body 为空）');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let lineBuffer = '';

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                lineBuffer += decoder.decode(value, { stream: true });

                let nl;
                while ((nl = lineBuffer.indexOf('\n')) !== -1) {
                    const line = lineBuffer.slice(0, nl).replace(/\r$/, '');
                    lineBuffer = lineBuffer.slice(nl + 1);

                    if (!line.startsWith('data:')) {
                        continue;
                    }
                    const payload = line.slice(5).trim();
                    if (!payload || payload === '[DONE]') {
                        continue;
                    }

                    let json;
                    try {
                        json = JSON.parse(payload);
                    } catch {
                        continue;
                    }

                    const b64 = json?.choices?.[0]?.delta?.audio?.data;
                    if (!b64) {
                        continue;
                    }
                    const bytes = base64ToBytes(b64);
                    if (bytes.length > 0) {
                        yield bytes;
                    }
                }
            }
        } finally {
            try {
                reader.releaseLock();
            } catch {
                /* ignore */
            }
        }
    }

    /** 直连请求（预置音色 / 分块流式） */
    postDirect(text, voiceId, stream, format, signal) {
        const style = String(this.settings.style || '').trim();
        const payload = {
            model: resolvePresetModel(this.settings.model),
            messages: [
                { role: 'user', content: style },
                { role: 'assistant', content: text },
            ],
            audio: { format: format || 'mp3', voice: voiceId },
        };
        if (stream) {
            payload.stream = true;
        }
        return this.postJson(payload, signal);
    }

    /** 统一发请求：带 api-key，并把浏览器那句没用的 "Failed to fetch" 翻译成人话 */
    postJson(payload, signal) {
        const key = String(this.settings.api_key || '').trim();
        if (!key) {
            throw new Error('请先在 MiMo 供应商设置里填写 API Key');
        }

        return fetch(MIMO_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': key,
            },
            signal,
            body: JSON.stringify(payload),
        }).catch(error => {
            if (isAbortError(error)) {
                throw error;
            }
            // 浏览器只会给一个笼统的 "TypeError: Failed to fetch"，
            // 换成能看懂的说明（网络中断 / 被拦截 / 跨域被拒）
            throw new Error(
                '无法连接 MiMo 接口（网络中断、被广告拦截器或代理拦下，或跨域被拒）。'
                + '请检查网络后重试；若开着 VPN / 广告拦截，先关掉再试。原始信息：'
                + (error?.message || error),
            );
        });
    }

    async previewTtsVoice(voiceId) {
        const resolved = this.resolveVoiceId(voiceId);
        this.audioElement.pause();
        this.audioElement.currentTime = 0;

        const { bytes, contentType } = await this.fetchWholeBytes(PREVIEW_TEXT, resolved);
        const audio = new Blob([bytes], { type: contentType });
        const url = URL.createObjectURL(audio);
        this.audioElement.src = url;
        this.audioElement.play();
        this.audioElement.onended = () => URL.revokeObjectURL(url);
    }
}

/**
 * 「模型」输入框是自由文本，用户可能把它填成 voicedesign。那个模型不接受 audio.voice，
 * 预置音色（直连 / 分块 / 中转）带上它必然 400，所以在这里提前拦下并给可操作的提示。
 */
function resolvePresetModel(model) {
    const m = String(model || '').trim();
    if (m === MODEL_DESIGN) {
        throw new Error('「模型」被填成了 mimo-v2.5-tts-voicedesign：该模型不接受 voice 字段，预置音色与中转都会 400。'
            + '音色设计请用面板下方的「音色设计」区（它会自动使用该模型），这里请改回 mimo-v2.5-tts。');
    }
    return m || MODEL_PRESET;
}

/** 宿主的多音色 voiceMapKey 带段类型后缀，取说话人名时要先去掉 */
function extractSpeakerName(voiceMapKey) {
    let name = String(voiceMapKey || '').trim();
    for (const suffix of MULTI_VOICE_KEY_SUFFIXES) {
        if (name.endsWith(suffix)) {
            name = name.slice(0, -suffix.length).trim();
            break;
        }
    }
    return name;
}

/**
 * 按需加载宿主的工具调用助手（Luker 的 scripts/lib/iter-tool-calling.js）。
 * 原版酒馆没有这个文件，所以只能动态 import + 容错；失败时清空缓存，允许下次重试。
 */
let toolCallHelperPromise = null;
async function loadToolCallHelper() {
    if (toolCallHelperPromise) {
        return toolCallHelperPromise;
    }
    toolCallHelperPromise = (async () => {
        const mod = await import('../../../lib/iter-tool-calling.js');
        if (typeof mod?.requestToolCallWithRetry !== 'function') {
            throw new Error('宿主缺少 requestToolCallWithRetry');
        }
        return mod;
    })();
    try {
        return await toolCallHelperPromise;
    } catch (error) {
        toolCallHelperPromise = null;
        throw error;
    }
}

const AUTO_DESIGN_SYSTEM_PROMPT = [
    'You are a casting assistant for a text-to-speech engine.',
    'Write a voice-design description for the given speaker, based on the speaker name, the quoted line and recent context.',
    'Cover where inferable: gender and age, timbre/texture, emotion and tone, speaking pace.',
    'Write in Chinese, 1 to 4 sentences.',
    'Describe only the voice; never mention recording, EQ, reverb, compression or other post-processing.',
    'Do not invent contradictory traits; if the evidence is thin, stay generic.',
    'Put the description in the required tool field and nothing else.',
].join('\n');

/** 给模型的用户消息：说话人 + 这一句 + 最近两条对话 */
function buildAutoDesignUserPrompt(context, speaker, line) {
    const parts = [`说话人：${speaker}`, `这一句台词：${String(line || '').trim()}`];
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const recent = [];
    for (let i = Math.max(0, chat.length - 2); i < chat.length; i++) {
        const message = chat[i];
        if (message && typeof message.mes === 'string' && message.mes.trim()) {
            recent.push(`${message.name || '未知'}: ${message.mes.trim().slice(0, 300)}`);
        }
    }
    if (recent.length > 0) {
        parts.push(`最近的对话：\n${recent.join('\n')}`);
    }
    parts.push('只输出 1~4 句中文音色描述。');
    return parts.join('\n\n');
}

/** 设计音色列表里的一行描述预览：压掉换行、超长截断（按码点切，避免把 emoji 劈成半个） */
function designPreview(prompt, max = 60) {
    const chars = Array.from(String(prompt || '').replace(/\s+/g, ' ').trim());
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

function escapeAttr(value) {
    return escapeHtml(value);
}

// ----------------------------------------------------------------------
//  注册供应商（下拉框里多一项 MiMo）
// ----------------------------------------------------------------------

let registered = false;

function ensureOption() {
    const select = document.getElementById('tts_provider');
    if (!select) {
        return;
    }
    const existing = select.querySelectorAll(`option[value="${PROVIDER_NAME}"]`);
    if (existing.length === 0) {
        const option = document.createElement('option');
        option.value = PROVIDER_NAME;
        option.textContent = PROVIDER_NAME;
        select.appendChild(option);
    } else {
        // 框架可能也追加过一次，去重
        for (let i = 1; i < existing.length; i++) {
            existing[i].remove();
        }
    }
}

export function init() {
    register();
}

function register() {
    scheduleUi();
    if (registered) {
        return;
    }
    try {
        registerTtsProvider(PROVIDER_NAME, MiMoTtsProvider);
        registered = true;
        console.info(`[MiMo TTS] v${VERSION} 供应商已注册`);
    } catch (error) {
        console.warn('[MiMo TTS] 注册失败（可能已注册）', error);
    }
}

function scheduleUi() {
    ensureOption();
    for (const ms of [0, 500, 1500, 3000]) {
        setTimeout(ensureOption, ms);
    }
    try {
        if (eventSource && event_types && event_types.APP_READY) {
            eventSource.on(event_types.APP_READY, ensureOption);
        }
    } catch {
        /* ignore */
    }
}

register();
