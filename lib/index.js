/**
 * dsh-sticker-dict —— 表情包字典 + GIF 抽帧拼图。
 *
 * 两件事，都能在「插件 → sticker-dict」那一行的面板上单独开关：
 *  1. 字典：看过的表情按内容 sha256 记下来，再发来直接查字典，
 *     不再喂给模型 —— 省掉重复识图的 token。
 *  2. 抽帧：GIF 抽若干帧横向拼成一张图，视觉模型一次看清整段动作。
 *     帧数、每帧边长都可以调。
 *
 * 对外提供：
 *  - 服务 `stickerDict`：contact / frame / lookup / remember / list / forget
 *  - 工具 `sticker_dict`、`gif_frame_extraction`（给模型自己调，可各自开关）
 *  - web panel（lib/client.js）+ bridge 路由 /api/dsh-sticker-dict-settings/{describe,mutate}
 */
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { gifContactSheet, DEFAULT_MAX_FRAMES } from './gif.js';
import { GifDict, gifFingerprint, imageFingerprint, sha256Of, DICT_MAX } from './dict.js';

export const name = 'sticker-dict';
export const inject = ['tools'];

/** 默认字典目录：~/.dsh/sticker-dict/dict（Windows / macOS / Linux 同一个写法）。 */
const defaultDictDir = () => join(homedir(), '.dsh', 'sticker-dict', 'dict');

/** 超过这个像素数（约 200 万）的非动图，默认当截图，不进字典占名额。 */
const STICKER_MAX_PIXELS = 2_000_000;

/** Config 用宿主自带的 @deepseek-ai/schemastery（与 onebot 同源，静态 import 会炸）。 */
const { default: Schema } = await import('@deepseek-ai/schemastery');

// bridge 用的设置命名空间 = cordis.patch.yml 里那一行的 id。
const STICKER_NS = 'sticker-dict';
const BRIDGE_PREFIX = '/api/dsh-sticker-dict-settings';
const MAX_JSON_BODY_BYTES = 64 * 1024;

export const Config = Schema.object({
    enabled: Schema.boolean().default(true)
        .description('总开关：关掉后本插件什么都不做（不影响别的插件）')
        .volatile(),
    frames: Schema.object({
        enabled: Schema.boolean().default(true)
            .description('gif_frame_extraction 抽帧工具：默认开启。把 GIF 抽成一张拼图交给视觉模型，才看得见整段动作；关掉则维持原样（只看得见第一帧）')
            .volatile(),
        maxFrames: Schema.number().min(1).max(12).step(1).default(DEFAULT_MAX_FRAMES)
            .description('抽几帧：均匀取首尾和中间，1~12 帧。5 帧适合大多数表情包，动作细的调到 8')
            .volatile(),
        cellPx: Schema.number().min(40).max(400).step(10).default(140)
            .description('每帧缩放到的边长（像素）：越大越清楚，拼图也越宽')
            .volatile(),
    }).description('抽帧设置'),
    dict: Schema.object({
        enabled: Schema.boolean().default(true)
            .description('sticker_dict 表情包字典：开启后看过的表情会记下来，再发来直接复用，不再识图')
            .volatile(),
        dir: Schema.string().default(defaultDictDir())
            .description('字典存放目录：一条一个 json，按内容 sha256 命名')
            .volatile(),
        maxEntries: Schema.number().min(10).max(100000).step(10).default(DICT_MAX)
            .description('字典最多存多少条，超出按最久没用的淘汰')
            .volatile(),
        reuseNote: Schema.boolean().default(true)
            .description('命中字典时把以前记录的描述带回去；关掉只回指纹（同一张图、第几次看到）')
            .volatile(),
        skipScreenshots: Schema.boolean().default(true)
            .description('截图不进字典：超过约 200 万像素或长宽比极端的非动图当截图，只回指纹不占名额（静态表情包照常记）')
            .volatile(),
    }).description('字典设置'),
});

/** 工具输出投影：defineTool 要求 output 必须有 schema 和 render。 */
function textOutput() {
    return {
        schema: { type: 'json' },
        render: (_args, value) => {
            const v = value ?? {};
            return [{ type: 'text', text: typeof v.text === 'string' ? v.text : '（无输出）' }];
        },
    };
}

// ── bridge 小工具（照 dsh-free-search 的写法）─────────────────────────

function writeJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
    res.end(payload);
}

async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_JSON_BODY_BYTES)
            return undefined;
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        return undefined;
    }
}

function parseAuthority(authority) {
    try {
        return new URL(`http://${authority}`);
    }
    catch {
        return null;
    }
}

function isLoopbackAddress(address) {
    const value = String(address ?? '');
    return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' || /^127\./.test(value);
}

function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * 只放行本机来源的 POST：拒绝跨站、Origin 必须同 host、来源地址必须是 loopback。
 * 这是个本地开关面板，不需要对外开放。
 */
function isBridgeRequestAllowed(req) {
    const host = req.headers.host;
    if (typeof host !== 'string')
        return false;
    const hostUrl = parseAuthority(host);
    if (hostUrl === null)
        return false;
    if (req.headers['sec-fetch-site'] === 'cross-site')
        return false;
    const origin = req.headers.origin;
    if (origin !== undefined) {
        try {
            if (new URL(origin).host !== hostUrl.host)
                return false;
        }
        catch {
            return false;
        }
    }
    return isLoopbackHostname(hostUrl.hostname) && isLoopbackAddress(req.socket?.remoteAddress);
}

function toView(descriptor) {
    return {
        ns: String(descriptor.ns),
        schema: descriptor.schema,
        value: descriptor.value,
        ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
        ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
        revision: descriptor.revision,
    };
}

/** 校验一条 set op，只接受本插件认识的路径。 */
const WRITABLE_PATHS = new Set([
    'enabled',
    'frames.enabled',
    'frames.maxFrames',
    'frames.cellPx',
    'dict.enabled',
    'dict.dir',
    'dict.maxEntries',
    'dict.reuseNote',
    'dict.skipScreenshots',
]);

function validateOp(op) {
    if (op === null || typeof op !== 'object')
        return 'op must be an object';
    if (op.op !== 'set')
        return `unsupported op "${String(op.op)}"`;
    if (!Array.isArray(op.path) || op.path.some((seg) => typeof seg !== 'string'))
        return 'op.path must be an array of strings';
    const key = op.path.join('.');
    if (!WRITABLE_PATHS.has(key))
        return `settings path "${key}" is not writable`;
    const value = op.value;
    const booleanKeys = ['enabled', 'frames.enabled', 'dict.enabled', 'dict.reuseNote', 'dict.skipScreenshots'];
    if (booleanKeys.includes(key) && typeof value !== 'boolean')
        return `settings path "${key}" expects a boolean`;
    if ((key === 'frames.maxFrames' || key === 'frames.cellPx' || key === 'dict.maxEntries')
        && (typeof value !== 'number' || !Number.isFinite(value)))
        return `settings path "${key}" expects a number`;
    if (key === 'dict.dir' && (typeof value !== 'string' || value.trim() === ''))
        return 'settings path "dict.dir" expects a non-empty string';
    return undefined;
}

function makeBridgeRoutes(settings, logger) {
    const allowlisted = () =>
        settings
            .describe({ redactSecrets: true })
            .filter((descriptor) => String(descriptor.ns) === STICKER_NS)
            .map((descriptor) => String(descriptor.ns));

    const handlers = {
        async describe() {
            const descriptors = settings.describe({ redactSecrets: true });
            const view = descriptors
                .filter((descriptor) => String(descriptor.ns) === STICKER_NS)
                .map(toView);
            if (view.length === 0) {
                return { ok: false, code: 'settings-not-found', message: `settings namespace "${STICKER_NS}" is not registered` };
            }
            return { ok: true, value: view[0].value ?? {}, writable: settings.writable !== false, revision: view[0].revision };
        },
        async mutate(request) {
            const body = request;
            if (body === null || typeof body !== 'object' || typeof body.ns !== 'string' || !Array.isArray(body.ops)) {
                return { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request' };
            }
            if (!allowlisted().includes(body.ns)) {
                return { ok: false, code: 'settings-not-exposed', message: `settings namespace "${body.ns}" is not exposed` };
            }
            for (const op of body.ops) {
                const problem = validateOp(op);
                if (problem !== undefined)
                    return { ok: false, code: 'settings-rejected', message: problem };
            }
            const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined;
            try {
                await settings.mutate(body.ns, body.ops, expectedRevision);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (/conflict/i.test(message))
                    return { ok: false, code: 'settings-conflict', message };
                return { ok: false, code: 'internal', message };
            }
            const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === body.ns);
            if (descriptor === undefined) {
                return { ok: false, code: 'internal', message: `settings namespace "${body.ns}" was disposed after the mutate` };
            }
            logger?.info?.(`配置已更新：${body.ops.map((op) => `${op.path.join('.')}=${JSON.stringify(op.value)}`).join(', ')}`);
            return { ok: true, value: toView(descriptor).value ?? {} };
        },
    };

    const guard = (req, res) => {
        if (!isBridgeRequestAllowed(req)) {
            writeJson(res, 403, { ok: false, code: 'forbidden', error: '请求必须来自本机' });
            return false;
        }
        if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, code: 'method-not-allowed', error: `method not allowed: ${req.method ?? ''}` });
            return false;
        }
        return true;
    };

    return [
        {
            kind: 'exact',
            path: `${BRIDGE_PREFIX}/describe`,
            handler: async (req, res) => {
                if (!guard(req, res))
                    return;
                writeJson(res, 200, await handlers.describe());
            },
        },
        {
            kind: 'exact',
            path: `${BRIDGE_PREFIX}/mutate`,
            handler: async (req, res) => {
                if (!guard(req, res))
                    return;
                const body = await readJsonBody(req);
                if (body === undefined) {
                    writeJson(res, 400, { ok: false, code: 'settings-rejected', error: 'malformed JSON body' });
                    return;
                }
                writeJson(res, 200, await handlers.mutate(body));
            },
        },
    ];
}

/**
 * `.volatile()` 字段是活值：拿到的是 { get(), [symbol]: write } 包装，
 * 不是普通 boolean。宿主的 loader 传进来的 config 就是这个形状，
 * 直接读会得到 `[object Object]`（上一版就是这么把开关读坏的）。
 * 每次用都要现读，不能缓存 —— 面板改完立即生效靠的就是这个。
 */
function unwrap(value, fallback) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        try {
            const actual = value.get();
            return actual === undefined ? fallback : actual;
        }
        catch {
            return fallback;
        }
    }
    return value === undefined ? fallback : value;
}

/** 把 loader 给的 config 摊平成普通对象（只摊一层，够用且不破坏嵌套读取）。 */
function resolveConfig(config) {
    if (config === null || typeof config !== 'object')
        return {};
    const out = {};
    for (const [key, value] of Object.entries(config))
        out[key] = unwrap(value, value);
    return out;
}

export function apply(ctx, config) {
    const logger = ctx.logger;

    /** 现读一次配置；总开关关着就什么都不做。 */
    function live() {
        const cfg = resolveConfig(config);
        const frames = cfg.frames !== null && typeof cfg.frames === 'object' ? resolveConfig(cfg.frames) : {};
        const dictCfg = cfg.dict !== null && typeof cfg.dict === 'object' ? resolveConfig(cfg.dict) : {};
        return { cfg, frames, dictCfg };
    }

    const initial = live();
    if (initial.cfg.enabled === false)
        return;

    // 字典目录/上限取自首次配置；改这两个要重启（面板只暴露开关，不暴露这两项）。
    const dict = new GifDict(
        initial.dictCfg.dir ?? defaultDictDir(),
        initial.dictCfg.maxEntries ?? DICT_MAX,
    );

    const framesOn = () => live().frames.enabled !== false;
    const dictOn = () => live().dictCfg.enabled !== false;
    /** 截图不收进字典（默认开；面板可关）。 */
    const skipScreenshots = () => live().dictCfg.skipScreenshots !== false;

    // ── 抽帧 ───────────────────────────────────────────────────
    async function contact(path, overrides = {}) {
        if (!framesOn())
            return undefined;
        const framesCfg = live().frames;
        return gifContactSheet(String(path), {
            maxFrames: overrides.maxFrames ?? framesCfg.maxFrames ?? DEFAULT_MAX_FRAMES,
            cellPx: overrides.cellPx ?? framesCfg.cellPx ?? 140,
            outPath: overrides.outPath,
        });
    }

    // ── 字典 ───────────────────────────────────────────────────
    /**
     * 判断这张图是不是「截图」：
     *  - 动图（多帧）永远是表情包，不是截图
     *  - 长宽比极端（超长滚动截图）→ 截图
     *  - 像素过多（大屏截图）→ 截图
     *  - 其余（含静态表情包）→ 当表情包
     * 只决定「要不要进字典占名额」，不影响识图本身。
     */
    function isScreenshot(fp) {
        if ((fp.frames ?? 0) > 1)
            return false;
        const w = fp.w ?? 0;
        const h = fp.h ?? 0;
        if (w > 0 && h > 0 && (w / h > 3 || h / w > 3))
            return true;
        return w * h > STICKER_MAX_PIXELS;
    }

    /** 查：命中返回记录（顺带 +1 次），没命中返回 { sha, fp } 表示新表情。 */
    async function lookup(path) {
        if (!dictOn())
            return undefined;
        let data;
        try {
            data = await readFile(String(path));
        }
        catch {
            return undefined;
        }
        const sha = sha256Of(data);
        const rec = await dict.get(sha);
        if (rec === undefined) {
            const fp = imageFingerprint(data);
            return { sha, fp, screenshot: isScreenshot(fp) };
        }
        return dict.touch(rec);
    }

    /** 记：登记或补描述。截图类不占字典名额（只回指纹，不落盘）。 */
    async function remember(path, note, force = false) {
        if (!dictOn())
            return undefined;
        let data;
        try {
            data = await readFile(String(path));
        }
        catch {
            return undefined;
        }
        const sha = sha256Of(data);
        const fp = imageFingerprint(data);
        if (isScreenshot(fp) && skipScreenshots() && force !== true)
            return { sha, fp, skipped: true };
        const rec = await dict.put(sha, {
            note: typeof note === 'string' && note.trim() !== '' ? note.trim() : undefined,
            ...fp,
        });
        void dict.prune();
        return rec;
    }

    /** 按 sha 定位一条：接受完整 sha 或前 8~64 位的唯一前缀。 */
    async function getBySha(sha) {
        if (!dictOn() || typeof sha !== 'string' || sha === '')
            return undefined;
        const key = sha.trim().toLowerCase();
        if (key.length >= 64)
            return dict.get(key);
        if (key.length < 8)
            return undefined;
        const rows = await dict.all();
        const hit = rows.find((r) => String(r.sha).toLowerCase().startsWith(key));
        return hit;
    }

    /** 改：只动 note / owner 两个字段，其余原样保留。 */
    async function annotate(sha, patch) {
        if (!dictOn())
            return undefined;
        const prev = await getBySha(sha);
        if (prev === undefined)
            return undefined;
        const clean = {};
        if (typeof patch?.note === 'string' && patch.note.trim() !== '')
            clean.note = patch.note.trim();
        if (typeof patch?.owner === 'string')
            clean.owner = patch.owner.trim() === '' ? undefined : patch.owner.trim();
        const rec = await dict.put(prev.sha, clean);
        return rec;
    }

    /** 忘掉一条。 */
    async function forget(path) {
        if (!dictOn())
            return false;
        try {
            const sha = sha256Of(await readFile(String(path)));
            await rm(dict.pathFor(sha), { force: true });
            return true;
        }
        catch {
            return false;
        }
    }

    /** 字典概览。 */
    async function list() {
        return {
            dir: initial.dictCfg.dir ?? defaultDictDir(),
            count: await dict.count(),
            maxEntries: initial.dictCfg.maxEntries ?? DICT_MAX,
            enabled: dictOn(),
        };
    }

    /** 列出若干条（概览用，按最近更新）。 */
    async function entries(limit = 20, keyword) {
        const rows = await dict.all();
        const kw = typeof keyword === 'string' ? keyword.trim() : '';
        const filtered = kw === ''
            ? rows
            : rows.filter((r) => `${r.note ?? ''} ${r.owner ?? ''} ${r.sha}`.includes(kw));
        return filtered.slice(0, Math.max(1, Math.min(200, limit))).map((r) => ({
            sha: r.sha,
            hash: String(r.sha).slice(0, 12),
            note: r.note,
            owner: r.owner,
            hits: r.hits ?? 0,
            at: r.at,
            format: r.format,
            w: r.w,
            h: r.h,
            frames: r.frames,
        }));
    }

    ctx.provide?.('stickerDict', { contact, frame: contact, lookup, remember, forget, list, annotate, entries, getBySha });

    // ── 工具 ───────────────────────────────────────────────────
    // 两个工具各自独立开关：关掉的那个直接不注册，模型工具表里也就看不见。
    const disposers = [];

    // 两个工具都注册上，但 execute 里现读开关：面板一改立即生效，
    // 不用重启，也不用重挂插件（重挂会打断正在跑的工具）。
    {
        disposers.push(ctx.tools.register(defineTool({
            name: 'gif_frame_extraction',
            description: '把 GIF 动图抽几帧拼成一张图，返回拼图路径（再用 read_image 看）。视觉模型默认只能看到 GIF 第一帧，抽帧后能看清整段动作。',
            parameters: {
                path: { type: 'string', required: true, description: 'GIF 文件路径' },
                maxFrames: { type: 'number', description: '抽几帧，省略则用插件配置' },
                cellPx: { type: 'number', description: '每帧边长像素，省略则用插件配置' },
            },
            output: textOutput(),
            isConcurrencySafe: () => true,
            execute: async (args) => {
                if (!framesOn())
                    return { text: 'gif_frame_extraction 已关闭：到「插件 → sticker-dict」面板把抽帧开关打开。' };
                // 先查字典：这张图以前看过就直接返回记录，省掉抽帧和重新识图。
                if (dictOn()) {
                    const known = await lookup(args.path);
                    if (known !== undefined && known.hits !== undefined) {
                        return {
                            text: `看过了，不用再抽帧：${known.note ?? '（当时没记描述）'}（命中 ${known.hits} 次）`,
                            cached: true,
                            note: known.note,
                            hits: known.hits,
                        };
                    }
                }
                const r = await contact(args.path, { maxFrames: args.maxFrames, cellPx: args.cellPx });
                if (r === undefined)
                    return { text: '抽帧失败：不是 GIF、解析不出画面，或抽帧开关关着。' };
                return {
                    text: `拼图：${r.path}（${r.width}×${r.height}，共 ${r.frames} 帧，取了 ${r.picked} 帧）`,
                    path: r.path,
                    width: r.width,
                    height: r.height,
                    frames: r.frames,
                    picked: r.picked,
                };
            },
        })));
    }

    {
        disposers.push(ctx.tools.register(defineTool({
            name: 'sticker_dict',
            description: '表情包字典：lookup 查这张图以前看过没有（GIF 和静态图都行）；remember 把看图结论记进去（下次直接复用、不再识图）；annotate 给某条加/改主人批注（owner），模型自己的描述 note 不动；forget 删一条；list 看规模或列条目。',
            parameters: {
                action: { type: 'string', required: true, description: 'lookup / remember / annotate / forget / list' },
                path: { type: 'string', description: '图片/GIF 路径（lookup / remember / forget 用）' },
                sha: { type: 'string', description: '完整 sha 或前 12 位 hash（annotate 用，也可只给 path）' },
                note: { type: 'string', description: '模型自己的一句话描述（remember 改 note 用）' },
                owner: { type: 'string', description: '主人批注：对这张表情的修正/补充，会一直带在记录里（annotate 用）' },
                keyword: { type: 'string', description: 'list 时按关键词过滤' },
                limit: { type: 'number', description: 'list 条目数，默认 20' },
                force: { type: 'boolean', description: 'remember 时强记：连截图类也收进字典（默认跳过）' },
            },
            output: textOutput(),
            isConcurrencySafe: () => true,
            execute: async (args) => {
                const action = String(args.action ?? '');
                const text = (t) => ({ text: t });
                if (action === 'list') {
                    const s = await list();
                    const kw = typeof args.keyword === 'string' ? args.keyword : '';
                    const limit = typeof args.limit === 'number' ? args.limit : 20;
                    const rows = await entries(limit, kw);
                    const head = `字典${s.enabled ? '' : '（已关）'}：${s.count} 条 / 上限 ${s.maxEntries}`;
                    if (rows.length === 0)
                        return text(kw === '' ? `${head}，里面是空的。` : `${head}，没有匹配「${kw}」的。`);
                    const lines = rows.map((r) => {
                        const owner = r.owner ? `｜批注：${r.owner}` : '';
                        return `- ${r.hash} ${r.note ?? '（没记描述）'}${owner}（${r.hits} 次）`;
                    });
                    return text(`${head}，列出 ${rows.length} 条：\n${lines.join('\n')}`);
                }
                if (!dictOn())
                    return text('sticker_dict 已关闭：到「插件 → sticker-dict」面板把字典开关打开。');
                if (action === 'annotate') {
                    let sha = typeof args.sha === 'string' ? args.sha.trim() : '';
                    if (sha === '' && typeof args.path === 'string' && args.path !== '') {
                        try {
                            sha = sha256Of(await readFile(args.path));
                        }
                        catch {
                            return text('读不了这个路径。');
                        }
                    }
                    if (sha === '')
                        return text('要给 sha（完整，或前 8~64 位前缀）或 path。');
                    const r = await annotate(sha, { note: args.note, owner: args.owner });
                    if (r === undefined)
                        return text('字典里没这条，先 remember 登记。');
                    const owner = typeof args.owner === 'string' && args.owner.trim() !== '' ? `｜批注：${args.owner.trim()}` : '｜批注已清空';
                    return text(`已更新 ${String(r.sha).slice(0, 12)}：${r.note ?? '（没记描述）'}${owner}`);
                }
                if (typeof args.path !== 'string' || args.path === '')
                    return text('要给 path。');
                if (action === 'lookup') {
                    const r = await lookup(args.path);
                    if (r === undefined)
                        return text('查不到：文件读不了，或字典开关关着。');
                    if (r.hits === undefined) {
                        const tag = r.screenshot ? '，看着像截图' : '';
                        return text(`新表情：sha ${String(r.sha).slice(0, 12)}，${r.fp?.w}×${r.fp?.h}，约 ${r.fp?.frames} 帧${tag}。`);
                    }
                    const owner = r.owner ? `｜主人批注：${r.owner}` : '';
                    return text(`看过：${r.note ?? '（当时没记描述）'}${owner}（命中 ${r.hits} 次）`);
                }
                if (action === 'remember') {
                    const r = await remember(args.path, args.note, args.force === true);
                    if (r === undefined)
                        return text('记不进去：文件读不了，或字典开关关着。');
                    if (r.skipped === true)
                        return text(`没记：${String(r.sha).slice(0, 12)} 看着是截图（${r.fp?.w}×${r.fp?.h}），不占字典名额。真要记就带 force。`);
                    return text(`已记：${String(r.sha).slice(0, 12)} ${r.note ?? '（只登记指纹）'}`);
                }
                if (action === 'forget') {
                    return text((await forget(args.path)) ? '已删。' : '删不了。');
                }
                return text(`不认识的 action：${action}`);
            },
        })));
    }

    // ── web 面板 bridge ────────────────────────────────────────
    try {
        ctx.inject(['webServer', 'settings'], (sctx) => {
            // rc.1 起插件配置就是 profile 里这一条自己的 Config，可编辑字段靠 .volatile()
            // 变成活值上报给 settings；这里只是声明「自带设置页」（auto:false），
            // 否则宿主不会把这条 config 当设置命名空间暴露出来，bridge 就会
            // 一直拿到 settings-not-found —— 面板点了没反应就是这个原因。
            sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));

            sctx.effect(() => {
                const routeDisposers = makeBridgeRoutes(sctx.settings, logger).map((route) => {
                    try {
                        return sctx.webServer.register(route);
                    }
                    catch (error) {
                        const message = String(error?.message ?? error);
                        if (error?.code === 'WEB_DUPLICATE_PROVIDER' || /already registered|duplicate/i.test(message)) {
                            logger?.warn?.(`sticker-dict: bridge 路由 "${route.path}" 已经注册过，复用现有的`);
                            return () => {};
                        }
                        throw error;
                    }
                });
                return () => {
                    for (const dispose of routeDisposers)
                        dispose?.();
                };
            }, 'sticker-dict: settings bridge');
        });
    }
    catch (error) {
        // 没有 web 环境（纯 CLI / 无 webServer）也不该把整个插件搞挂。
        logger?.warn?.(`sticker-dict: 面板 bridge 挂不上（${String(error?.message ?? error)}），工具照常可用`);
    }

    ctx.on?.('dispose', () => {
        for (const d of disposers)
            d?.();
    });

    const bootCfg = live();
    logger?.info?.(
        `sticker-dict: 抽帧 ${bootCfg.frames.enabled === false ? '关' : `${bootCfg.frames.maxFrames ?? DEFAULT_MAX_FRAMES} 帧`} · `
        + `字典 ${bootCfg.dictCfg.enabled === false ? '关' : (bootCfg.dictCfg.dir ?? defaultDictDir())}`,
    );
}

export { gifContactSheet, parseGif } from './gif.js';
export { GifDict } from './dict.js';
