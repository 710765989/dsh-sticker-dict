/**
 * GIF 抽帧 + 拼图。
 *
 * QQ 表情包基本都是 GIF 动图，而视觉模型一次只能看到第一帧，等于白看。
 * 这里把动图抽出若干帧，横向拼成一张图，模型一次就能看完整段动作，
 * token 只花一张图的量。
 *
 * 不依赖 @napi-rs/canvas 的 GIF 解码（它只给第一帧），自己按 GIF89a 规范
 * 遍历结构块、解 LZW、排交错、合成帧间叠放。画布用 @napi-rs/canvas。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';

/** 抽帧上限：再多也只是画面重复，价值递减。 */
export const DEFAULT_MAX_FRAMES = 5;

/** 单帧目标边长（像素）：5 帧拼起来约 700px 宽，够看清动作。 */
const CELL_PX = 140;

const toBuf = (b) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b));

const u16 = (d, i) => d[i] | (d[i + 1] << 8);

/** 跳过 GIF 的若干「子块」（长度字节 + 数据…，以 0 结尾）。返回结束位置，坏了返回 -1。 */
function skipSubBlocks(d, i) {
    while (i < d.length) {
        const size = d[i];
        i += 1;
        if (size === 0)
            return i;
        i += size;
    }
    return -1;
}

/** 把小端 RGB 表展开成颜色（ABGR 低 24 位，最高位亮度标记）。 */
function readPalette(d, start, count) {
    const out = new Uint32Array(count);
    for (let k = 0; k < count; k += 1) {
        const p = start + k * 3;
        if (p + 2 >= d.length)
            break;
        out[k] = (0xff000000 | (d[p + 2] << 16) | (d[p + 1] << 8) | d[p]) >>> 0;
    }
    return out;
}

/**
 * GIF LZW 解压，输出调色板索引。
 * 变长码（小端按位打包）、clear 码重置码表、end 码收尾，码表最多 4096 项。
 */
function lzwDecode(minCodeSize, data, pixelCount) {
    const out = new Uint8Array(pixelCount);
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    let dict = [];
    let next = clear + 2;
    let codeSize = minCodeSize + 1;
    let prev = -1;
    const reset = () => {
        dict = new Array(clear + 2);
        for (let k = 0; k < clear; k += 1)
            dict[k] = [k];
        dict[clear] = [];
        dict[end] = [];
        next = clear + 2;
        codeSize = minCodeSize + 1;
        prev = -1;
    };
    reset();
    let bitPos = 0;
    let written = 0;
    while (written < pixelCount) {
        if (bitPos + codeSize > data.length * 8)
            break;
        let code = 0;
        for (let b = 0; b < codeSize; b += 1) {
            const bit = (data[(bitPos + b) >> 3] >> ((bitPos + b) & 7)) & 1;
            code |= bit << b;
        }
        bitPos += codeSize;
        if (code === clear) {
            reset();
            continue;
        }
        if (code === end)
            break;
        let entry;
        if (code < next && dict[code] !== undefined)
            entry = dict[code];
        else if (prev >= 0 && dict[prev] !== undefined)
            entry = [...dict[prev], dict[prev][0]];
        else
            break;
        for (let k = 0; k < entry.length && written < pixelCount; k += 1)
            out[written++] = entry[k];
        if (prev >= 0 && next < 4096) {
            dict[next++] = [...dict[prev], entry[0]];
            if (next === 1 << codeSize && codeSize < 12)
                codeSize += 1;
        }
        prev = code;
    }
    return out;
}

/** 图像描述符的交错行序（GIF 的 4 段规则）。 */
function interlaceRows(fh) {
    const rows = [];
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]])
        for (let y = start; y < fh; y += step)
            rows.push(y);
    return rows;
}

/**
 * 解析 GIF，返回每帧完整画面（已按 disposal / 透明色合成）。
 * @param d - GIF 文件字节。
 * @returns {{ w: number, h: number, frames: Uint32Array[] }}
 */
export function parseGif(d) {
    const none = { w: 0, h: 0, frames: [] };
    if (d.length < 13 || d[0] !== 0x47 || d[1] !== 0x49 || d[2] !== 0x46)
        return none;
    const sw = u16(d, 6);
    const sh = u16(d, 8);
    if (sw <= 0 || sh <= 0 || d.length < 14)
        return none;
    const packed = d[10];
    const bgIndex = d[11];
    let i = 13;
    let global = null;
    if (packed & 0x80) {
        const size = 2 << (packed & 0x07);
        global = readPalette(d, i, size);
        i += size * 3;
    }
    const blank = () => {
        const px = new Uint32Array(sw * sh);
        px.fill(global && bgIndex < global.length ? global[bgIndex] : 0xff000000);
        return px;
    };
    let canvasPx = blank();
    const frames = [];
    /** 图形控制扩展暂存：画下一帧时才用到。 */
    let pending = null;
    while (i < d.length) {
        const b = d[i];
        if (b === 0x3b)
            break; // trailer
        if (b === 0x21) {
            if (i + 1 >= d.length)
                break;
            const label = d[i + 1];
            if (label === 0xf9) {
                const size = d[i + 2] ?? 0;
                const flags = d[i + 3] ?? 0;
                const delay = u16(d, i + 4);
                const transparent = flags & 1 ? d[i + 6] : -1;
                const next = skipSubBlocks(d, i + 2 + size + 1);
                if (next < 0)
                    return { w: sw, h: sh, frames };
                i = next;
                pending = { delay, transparent, disposal: (flags >> 2) & 0x07 };
                continue;
            }
            const next = skipSubBlocks(d, i + 2);
            if (next < 0)
                return { w: sw, h: sh, frames };
            i = next;
            continue;
        }
        if (b !== 0x2c) {
            i += 1;
            continue;
        }
        if (i + 10 > d.length)
            return { w: sw, h: sh, frames };
        const fx = u16(d, i + 1);
        const fy = u16(d, i + 3);
        const fw = u16(d, i + 5);
        const fh = u16(d, i + 7);
        const fpacked = d[i + 9];
        i += 10;
        let palette = global;
        if (fpacked & 0x80) {
            const size = 2 << (fpacked & 0x07);
            palette = readPalette(d, i, size);
            i += size * 3;
        }
        if (!palette || fw <= 0 || fh <= 0) {
            const skip = i < d.length ? skipSubBlocks(d, i + 1) : -1;
            if (skip < 0)
                return { w: sw, h: sh, frames };
            i = skip;
            continue;
        }
        const minCode = d[i];
        i += 1;
        const chunks = [];
        let total = 0;
        for (;;) {
            if (i >= d.length)
                return { w: sw, h: sh, frames };
            const size = d[i];
            i += 1;
            if (size === 0)
                break;
            if (i + size > d.length)
                return { w: sw, h: sh, frames };
            chunks.push(d.subarray(i, i + size));
            total += size;
            i += size;
        }
        const lzw = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
            lzw.set(c, off);
            off += c.length;
        }
        const indices = lzwDecode(minCode, lzw, fw * fh);
        const before = pending;
        pending = null;
        if (before && before.disposal === 2)
            canvasPx = blank(); // 上一帧要求「绘制后清空」
        const interlaced = (fpacked & 0x40) !== 0;
        const rows = interlaced ? interlaceRows(fh) : null;
        const transparent = before ? before.transparent : -1;
        for (let n = 0; n < indices.length; n += 1) {
            const idx = indices[n];
            if (idx === transparent)
                continue;
            const rowPos = rows ? rows[Math.floor(n / fw)] : Math.floor(n / fw);
            if (rowPos === undefined)
                break;
            const gx = fx + (n % fw);
            const gy = fy + rowPos;
            if (gx >= sw || gy >= sh)
                continue;
            canvasPx[gy * sw + gx] = idx < palette.length ? palette[idx] : 0xff000000;
        }
        frames.push(Uint32Array.from(canvasPx));
    }
    return { w: sw, h: sh, frames };
}

/** 从若干帧里均匀挑出至多 maxFrames 帧的下标（首尾必取）。 */
export function pickFrameIndices(total, maxFrames) {
    const n = Math.max(1, Math.min(maxFrames, total));
    if (total <= n)
        return Array.from({ length: total }, (_, k) => k);
    if (n === 1)
        return [0];
    const out = [];
    for (let k = 0; k < n; k += 1)
        out.push(Math.round((k * (total - 1)) / (n - 1)));
    return out;
}

/**
 * 把 GIF 抽帧拼成一张横向长图（PNG）。
 * @param src - GIF 文件路径。
 * @param options - { maxFrames?: number, cellPx?: number, outPath?: string }
 * @returns 拼图路径与元信息；不是 GIF 或解析不出帧时返回 undefined。
 */
export async function gifContactSheet(src, options = {}) {
    let data;
    try {
        data = toBuf(await readFile(src));
    }
    catch {
        return undefined;
    }
    const { w, h, frames } = parseGif(data);
    if (frames.length === 0)
        return undefined;
    const picks = pickFrameIndices(frames.length, options.maxFrames ?? DEFAULT_MAX_FRAMES);
    const cellPx = options.cellPx ?? CELL_PX;
    const scale = Math.min(1, cellPx / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const sheetW = cw * picks.length;
    const canvas = createCanvas(sheetW, ch);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, sheetW, ch);
    const cell = createCanvas(cw, ch);
    const cctx = cell.getContext('2d');
    const img = cctx.createImageData(cw, ch);
    picks.forEach((frameIndex, slot) => {
        const px = frames[frameIndex];
        const out = img.data;
        for (let y = 0; y < ch; y += 1) {
            const sy = Math.min(h - 1, Math.floor(y / scale));
            for (let x = 0; x < cw; x += 1) {
                const sx = Math.min(w - 1, Math.floor(x / scale));
                const c = px[sy * w + sx] ?? 0xff000000;
                const o = (y * cw + x) * 4;
                out[o] = (c >>> 16) & 0xff;
                out[o + 1] = (c >>> 8) & 0xff;
                out[o + 2] = c & 0xff;
                out[o + 3] = 0xff;
            }
        }
        cctx.putImageData(img, 0, 0);
        ctx.drawImage(cell, slot * cw, 0, cw, ch);
    });
    const outPath = options.outPath ?? src.replace(/\.[^.]+$/, '') + `-gif${picks.length}.png`;
    try {
        await writeFile(outPath, canvas.toBuffer('image/png'));
    }
    catch {
        return undefined;
    }
    return { path: outPath, width: sheetW, height: ch, frames: frames.length, picked: picks.length };
}
