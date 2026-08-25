// dsh-highres-vision — 纯 Node 分块引擎（v0.2.0，替代 scripts/tile_image.py）
//
// 与旧版 Python 脚本保持同一套分块策略：
//   1. 宽或高 > tile(800) 时，先输出整图缩略图（<=800x800），再切子块；
//   2. 相邻子块按原图分辨率自动重叠（40/80/120px）；
//   3. 宽高都 <= 800 时只输出整图。
// 所有文件输出为 PNG，供宿主 read_image 注入模型。

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Jimp } from 'jimp'

export const TILE_SIZE = 800

/** 按原图最大边自动选择重叠像素（与 v0.1.x 的 tile_image.py 一致）。 */
export function autoOverlap(width, height, tile = TILE_SIZE) {
  const maxSide = Math.max(width, height)
  if (maxSide <= 1600) return Math.max(20, Math.round(tile * 0.05)) // ≈40px
  if (maxSide <= 3000) return Math.round(tile * 0.10) // ≈80px
  return Math.round(tile * 0.15) // ≈120px
}

/**
 * 返回某个轴向的切块起点列表，使每个切块尽量接近 tile 大小。
 * - 起点从 0 开始；
 * - 最后一块的右/下边界刚好到达 length；
 * - 相邻起点间隔 <= tile - overlap，保证重叠 >= overlap。
 */
export function splitAxis(length, tile = TILE_SIZE, overlap = 20) {
  if (length <= tile) return [0]

  let ov = overlap
  if (ov >= tile) ov = Math.max(0, tile - 1)

  const progress = tile - ov
  const n = Math.max(2, Math.ceil((length - ov) / progress))
  const last = length - tile
  if (n === 2) return [0, last]

  const xs = Array.from({ length: n }, (_, i) => Math.round((i * last) / (n - 1)))
  xs[0] = 0
  xs[n - 1] = last
  return xs
}

/** 返回所有子块 {x, y, w, h}（先行后列）。w/h 是块宽高，不是右/下边界。 */
export function splitTiles(width, height, tile = TILE_SIZE, overlap = 20) {
  const xs = splitAxis(width, tile, overlap)
  const ys = splitAxis(height, tile, overlap)
  const boxes = []
  for (const y of ys) {
    for (const x of xs) {
      boxes.push({
        x,
        y,
        w: Math.min(tile, width - x),
        h: Math.min(tile, height - y),
      })
    }
  }
  return boxes
}

/**
 * 把 inputPath 图片切成「整图缩略图 + N 个子块」，全部写入 emitDir。
 * 返回与旧版 tile_image.py --emit-images 同结构的 JSON 计划。
 */
export async function tileImage(
  inputPath,
  {
    tile = TILE_SIZE,
    overlap: overlapArg,
    skipWhole = false,
    maxTiles = 0,
    emitDir,
  } = {},
) {
  const data = await readFile(inputPath)
  const img = await Jimp.read(data)
  const w = img.bitmap.width
  const h = img.bitmap.height

  const overlap = overlapArg == null || overlapArg === 0 ? autoOverlap(w, h, tile) : overlapArg
  const needSplit = w > tile || h > tile

  await mkdir(emitDir, { recursive: true })

  const result = {
    ok: true,
    originalSize: [w, h],
    strategy: needSplit ? 'whole-first-then-tiles' : 'whole-only',
    tileSize: tile,
    overlap,
    whole: null,
    tiles: [],
    tileCount: 0,
  }

  // 1) 整图缩略图（全局上下文）
  if (!skipWhole) {
    let wholePath
    let wholeW = w
    let wholeH = h
    if (needSplit) {
      // 等比缩放到 <= tile x tile，避免拉伸变形
      const scale = Math.min(tile / w, tile / h)
      wholeW = Math.max(1, Math.round(w * scale))
      wholeH = Math.max(1, Math.round(h * scale))
      const wholeImg = img.clone().resize({ w: wholeW, h: wholeH })
      wholePath = join(emitDir, 'whole.png')
      await wholeImg.write(wholePath)
    } else {
      wholePath = join(emitDir, 'whole.png')
      await img.clone().write(wholePath)
    }
    result.whole = {
      path: wholePath,
      box: [0, 0, w, h],
      size: [wholeW, wholeH],
    }
  }

  // 2) 子块
  if (needSplit) {
    let boxes = splitTiles(w, h, tile, overlap)
    if (maxTiles > 0) boxes = boxes.slice(0, maxTiles)

    for (let i = 0; i < boxes.length; i++) {
      const { x, y, w: tw, h: th } = boxes[i]
      const tileImg = img.clone().crop({ x, y, w: tw, h: th })
      const tilePath = join(emitDir, `tile_${String(i + 1).padStart(3, '0')}_x${x}_y${y}.png`)
      await tileImg.write(tilePath)
      result.tiles.push({
        index: i + 1,
        path: tilePath,
        box: [x, y, x + tw, y + th],
        size: [tw, th],
      })
    }
    result.tileCount = result.tiles.length
  }

  return result
}
