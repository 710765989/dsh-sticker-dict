/**
 * 表情包字典：把「看过的 gif」按内容 sha256 记下来。
 *
 * 同一个表情再发来，就不用再喂给视觉模型了 —— 按 key 查到以前的记录，
 * 直接把说明 / 指纹带回去。省掉第二次识图的 token。
 *
 * 一条一个 JSON：`<dir>/<sha256>.json`
 * 字段：{ v, sha, note, w, h, frames, source, at, hits }
 *   note   —— 模型看过之后写的一句话描述（没有就是看过但没记）
 *   hits   —— 被查到几次
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 字典最大条数，超出按最久没访问淘汰。 */
export const DICT_MAX = 2000;

/** 内容指纹。 */
export function sha256Of(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

/** GIF 头信息：宽高 + 帧数（按结构块走一遍，别拿字节瞎猜）。 */
export function gifFingerprint(data) {
    if (data.length < 13)
        return { w: 0, h: 0, frames: 0 };
    const w = data[6] | (data[7] << 8);
    const h = data[8] | (data[9] << 8);
    let i = 13;
    if (data[10] & 0x80)
        i += (2 << (data[10] & 0x07)) * 3;
    let frames = 0;
    while (i < data.length) {
        const b = data[i];
        if (b === 0x3b)
            break;
        if (b === 0x21) {
            if (i + 1 >= data.length)
                break;
            i += 2;
            for (;;) { // 跳过子块链
                const size = data[i] ?? 0;
                i += 1;
                if (size === 0)
                    break;
                i += size;
            }
            continue;
        }
        if (b !== 0x2c) {
            i += 1;
            continue;
        }
        frames += 1;
        if (i + 10 > data.length)
            break;
        const packed = data[i + 9];
        i += 10;
        if (packed & 0x80)
            i += (2 << (packed & 0x07)) * 3;
        i += 1; // LZW 最小码长
        for (;;) {
            const size = data[i] ?? 0;
            i += 1;
            if (size === 0)
                break;
            i += size;
        }
    }
    return { w, h, frames };
}

/**
 * 通用图片指纹：认 GIF / PNG / JPEG / WebP 的结构头，拿到宽高与帧数，
 * 顺带认出格式。静态图（PNG/JPEG/WebP 单帧）frames = 1。
 */
export function imageFingerprint(data) {
    if (data.length < 12)
        return { w: 0, h: 0, frames: 0, format: 'unknown' };
    // GIF87a / GIF89a
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
        const fp = gifFingerprint(data);
        return { ...fp, format: 'gif' };
    }
    // PNG：IHDR 紧跟 8 字节签名 + 4 字节长度 + 'IHDR'
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
        const w = data.readUInt32BE(16);
        const h = data.readUInt32BE(20);
        return { w, h, frames: 1, format: 'png' };
    }
    // JPEG：扫 SOFn 段
    if (data[0] === 0xff && data[1] === 0xd8) {
        let i = 2;
        while (i + 9 < data.length) {
            if (data[i] !== 0xff) { i += 1; continue; }
            const marker = data[i + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            const len = data.readUInt16BE(i + 2);
            // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                const h = data.readUInt16BE(i + 5);
                const w = data.readUInt16BE(i + 7);
                return { w, h, frames: 1, format: 'jpeg' };
            }
            i += 2 + len;
        }
        return { w: 0, h: 0, frames: 1, format: 'jpeg' };
    }
    // WebP：RIFF....WEBP
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
        && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
        const chunk = data.slice(12, 16).toString('ascii');
        if (chunk === 'VP8 ') {
            const w = data.readUInt16LE(26) & 0x3fff;
            const h = data.readUInt16LE(28) & 0x3fff;
            return { w, h, frames: 1, format: 'webp' };
        }
        if (chunk === 'VP8L') {
            const b = data.readUInt32LE(21);
            const w = (b & 0x3fff) + 1;
            const h = ((b >> 14) & 0x3fff) + 1;
            return { w, h, frames: 1, format: 'webp' };
        }
        if (chunk === 'VP8X') {
            const w = data.readUIntLE(24, 3) + 1;
            const h = data.readUIntLE(27, 3) + 1;
            return { w, h, frames: 1, format: 'webp' };
        }
        return { w: 0, h: 0, frames: 1, format: 'webp' };
    }
    return { w: 0, h: 0, frames: 0, format: 'unknown' };
}

export class GifDict {
    /**
     * @param dir - 字典目录（插件 config 决定）。
     * @param maxEntries - 条数上限。
     */
    constructor(dir, maxEntries = DICT_MAX) {
        this.dir = dir;
        this.maxEntries = maxEntries > 0 ? maxEntries : DICT_MAX;
    }
    pathFor(sha) {
        return join(this.dir, `${sha}.json`);
    }
    /** 读一条，坏文件当没有。 */
    async get(sha) {
        try {
            const rec = JSON.parse(await readFile(this.pathFor(sha), 'utf8'));
            return typeof rec === 'object' && rec !== null ? rec : undefined;
        }
        catch {
            return undefined;
        }
    }
    /** 写一条（与已有字段合并）。 */
    async put(sha, patch) {
        await mkdir(this.dir, { recursive: true });
        const prev = (await this.get(sha)) ?? { v: 1, sha, hits: 0 };
        const rec = { ...prev, ...patch, sha, at: Date.now() };
        await writeFile(this.pathFor(sha), JSON.stringify(rec), 'utf8');
        return rec;
    }
    /** 命中一次，hits + 1（顺手更新 mtime，淘汰时算「最近用过」）。 */
    async touch(rec) {
        if (!rec?.sha)
            return undefined;
        return this.put(rec.sha, { hits: (rec.hits ?? 0) + 1 });
    }
    /** 全部条数。 */
    async count() {
        try {
            return (await readdir(this.dir)).filter((n) => n.endsWith('.json')).length;
        }
        catch {
            return 0;
        }
    }
    /** 读全部记录（坏文件跳过），按最近更新倒序。 */
    async all() {
        let names;
        try {
            names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
        }
        catch {
            return [];
        }
        const rows = [];
        for (const name of names) {
            try {
                const rec = JSON.parse(await readFile(join(this.dir, name), 'utf8'));
                if (rec !== null && typeof rec === 'object')
                    rows.push(rec);
            }
            catch {
                // 坏文件跳过
            }
        }
        rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
        return rows;
    }
    /** 超上限按 mtime 淘汰。 */
    async prune() {
        try {
            const names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
            if (names.length <= this.maxEntries)
                return 0;
            const entries = [];
            for (const name of names) {
                try {
                    entries.push({ name, mtime: (await stat(join(this.dir, name))).mtimeMs });
                }
                catch {
                    // 半路没了就算了
                }
            }
            entries.sort((a, b) => a.mtime - b.mtime);
            const drop = entries.slice(0, entries.length - this.maxEntries);
            for (const { name } of drop)
                await rm(join(this.dir, name), { force: true });
            return drop.length;
        }
        catch {
            return 0;
        }
    }
}
