#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tile_image.py - DeepSeek-V4-Flash-Vision-Exp 大图分块识图

策略（规范化识图逻辑）：
1. 读入图片。
2. 若宽或高 > TILE(800)：
     2.1 先把整图缩放到 <=800x800，识别一次（全局上下文，必须先做）。
     2.2 再切成多个 <=800x800 的子块，优先让每一块尽可能接近 TILE(800)，
         相邻块至少有 OVERLAP(20)px 重叠，逐块识别。
3. 若宽和高都 <=800x800：只做一次整图识别。
4. 输出结构化 JSON：
     {
       "tool": "tile_image",
       "ok": true,
       "image": "...",
       "originalSize": [w, h],
       "strategy": "whole-first-then-tiles" | "whole-only",
       "tileSize": 800,
       "overlap": 20,
       "whole": { "text": "..." },
       "tiles": [ { "index": 1, "box": [x1,y1,x2,y2], "size": [w,h], "text": "..." } ],
       "tileCount": 4,
       "dryRun": false
     }

用法：
  python tile_image.py "path/to/image.jpg"
  python tile_image.py img.png --tile 800 --overlap 0 --skip-whole  # 0=自动重叠
  python tile_image.py img.png --question "只看右上角文字" --save-tiles tiles/
  python tile_image.py img.png --dry-run   # 不调用 API，只规划/保存

依赖：pip install pillow
API Key：环境变量 DEEPSEEK_API_KEY，或 --api-key
"""

import argparse
import base64
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit('缺少 Pillow，请先安装：pip install pillow')

DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
DEFAULT_MODEL = 'deepseek-v4-flash-vision-exp'
DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

PROMPT_WHOLE = (
    '这是一张完整图片（为适配模型输入限制，已缩小到不超过 800x800）。'
    '请先概括整图的主题/场景/构图/氛围，再指出图中最值得注意的细节。'
    '如果图中有文字，请原样转录。'
)

PROMPT_TILE = (
    '这是同一张大图切出来的一个子块（已保证不超过 800x800，且与相邻块至少有 20px 重叠）。'
    '请只描述这一块里的内容：人物/物体/文字/细节/背景，尽可能完整准确。'
    '如果包含文字请原样转录。不要臆测块外的内容。'
)


def split_axis(length, tile=800, overlap=20):
    """返回某个轴向的切块起点列表，使每个切块尽量接近 tile 大小。

    规则：
    - 起点从 0 开始；
    - 最后一块的右/下边界刚好到达 length（因此最后一块也是满 tile 宽/高）；
    - 相邻起点间隔 = (length - tile) / (n - 1)，该间隔 <= tile - overlap，
      所以相邻块重叠 >= overlap，且不会出现很小的边缘碎块。
    - n 取能覆盖 length 的最小数量，保证每块分辨率尽量高。
    """
    if length <= tile:
        return [0]

    if overlap >= tile:
        overlap = max(0, tile - 1)

    # 每个块的“有效推进量”：满 tile 块之间至少保留 overlap 重叠。
    progress = tile - overlap
    n = max(2, math.ceil((length - overlap) / progress))

    # 最后一块起点 = length - tile，使最后一块也是满 tile 大小。
    last = length - tile
    if n == 2:
        return [0, last]

    # 均匀分布中间起点，所有块都尽量取满 tile。
    xs = [round(i * last / (n - 1)) for i in range(n)]
    xs[0] = 0
    xs[-1] = last
    return xs


def auto_overlap(size, tile=800):
    """按原图最大边自动选择重叠像素：分辨率越高，重叠越大。

    - 最大边 <= 1600px：5%（约 40px）
    - 最大边 <= 3000px：10%（约 80px）
    - 最大边 >  3000px：15%（约 120px）
    """
    max_side = max(size)
    if max_side <= 1600:
        return max(20, round(tile * 0.05))
    if max_side <= 3000:
        return round(tile * 0.10)
    return round(tile * 0.15)


def split_tiles(img, tile=800, overlap=20):
    """把图片切成若干块，每块尽量接近 tile x tile，相邻块重叠 >= overlap。

    返回 (x1,y1,x2,y2) 列表。
    """
    w, h = img.size
    xs = split_axis(w, tile, overlap)
    ys = split_axis(h, tile, overlap)
    boxes = []
    for y in ys:
        for x in xs:
            boxes.append((x, y, min(x + tile, w), min(y + tile, h)))
    return boxes


def to_jpeg_b64(img, quality=92):
    """把 PIL Image 转成 JPEG base64。"""
    buf = io.BytesIO()
    img.convert('RGB').save(buf, format='JPEG', quality=quality)
    return base64.b64encode(buf.getvalue()).decode('utf-8')


def call_vision(image_b64, prompt, model, base_url, api_key, mime='image/jpeg', retries=3):
    """调用 OpenAI Chat Completions 协议的视觉接口，返回文本或错误字符串。"""
    url = base_url.rstrip('/') + '/chat/completions'
    body = {
        'model': model,
        'messages': [
            {
                'role': 'user',
                'content': [
                    {'type': 'text', 'text': prompt},
                    {
                        'type': 'image_url',
                        'image_url': {'url': f'data:{mime};base64,{image_b64}'},
                    },
                ],
            }
        ],
        'max_tokens': 2048,
    }
    payload = json.dumps(body).encode('utf-8')
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }

    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            return data['choices'][0]['message']['content']
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read().decode('utf-8', 'replace')
            except Exception:
                pass
            if e.code == 429 and attempt < retries:
                time.sleep(5 * attempt)
                continue
            return f'[HTTP {e.code}] {detail}'
        except Exception as e:
            if attempt < retries:
                time.sleep(5)
                continue
            return f'[ERROR] {e}'
    return '[ERROR] retries exhausted'


def build_prompt(base, question):
    if not question:
        return base
    return f'{base}\n\n用户重点关注：{question}'


def emit_image_files(img, need_split, emit_dir, args, src_path):
    """把整图和所有子块保存为文件，不调用任何 API；返回文件路径 JSON。"""
    emit_dir = Path(emit_dir)
    emit_dir.mkdir(parents=True, exist_ok=True)
    w, h = img.size

    whole = None
    if not args.skip_whole:
        if need_split:
            whole_img = img.copy()
            whole_img.thumbnail((args.tile, args.tile), Image.Resampling.LANCZOS)
        else:
            whole_img = img
        whole_path = emit_dir / 'whole.png'
        whole_img.save(whole_path)
        whole = {
            'path': str(whole_path),
            'box': [0, 0, w, h],
            'size': list(whole_img.size),
        }

    tiles = []
    if need_split:
        boxes = split_tiles(img, args.tile, args.overlap)
        if args.max_tiles > 0:
            boxes = boxes[: args.max_tiles]
        for i, (x1, y1, x2, y2) in enumerate(boxes, 1):
            tile_img = img.crop((x1, y1, x2, y2))
            tile_path = emit_dir / f'tile_{i:03d}_x{x1}_y{y1}.png'
            tile_img.save(tile_path)
            tiles.append({
                'index': i,
                'path': str(tile_path),
                'box': [x1, y1, x2, y2],
                'size': list(tile_img.size),
            })

    return {
        'tool': 'tile_image',
        'ok': True,
        'image': str(src_path),
        'originalSize': [w, h],
        'strategy': 'whole-first-then-tiles' if need_split else 'whole-only',
        'tileSize': args.tile,
        'overlap': args.overlap,
        'whole': whole,
        'tiles': tiles,
        'tileCount': len(tiles),
        'dryRun': False,
    }


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    ap = argparse.ArgumentParser(description='DeepSeek V4 Flash Vision Exp 大图分块识图')
    ap.add_argument('image', help='图片路径')
    ap.add_argument('--tile', type=int, default=800, help='单块最大边长（默认 800）')
    ap.add_argument('--overlap', type=int, default=0, help='块间重叠像素；0=自动，按原图分辨率选择 40/80/120px')
    ap.add_argument('--model', default=os.environ.get('DSV4FLASH_MODEL', DEFAULT_MODEL))
    ap.add_argument('--base-url', default=os.environ.get('DEEPSEEK_BASE_URL', DEFAULT_BASE_URL))
    ap.add_argument('--api-key', default=os.environ.get(DEFAULT_API_KEY_ENV, ''))
    ap.add_argument('--question', default='', help='重点关注的问题/要点')
    ap.add_argument('--save-tiles', default='', help='把切出来的块保存到该目录')
    ap.add_argument('--skip-whole', action='store_true', help='不发送整图识别')
    ap.add_argument('--max-tiles', type=int, default=0, help='最多识别多少块（0 为不限）')
    ap.add_argument('--dry-run', action='store_true', help='只做切块规划/保存，不调用 API')
    ap.add_argument('--emit-images', default='', help='把整图/所有子块保存到该目录（不调用 API），并输出文件路径 JSON')
    args = ap.parse_args()

    src = Path(args.image)
    if not src.exists():
        print(json.dumps({
            'tool': 'tile_image',
            'ok': False,
            'error': f'文件不存在：{src}',
        }, ensure_ascii=False, indent=2))
        return

    try:
        img = Image.open(src)
        w, h = img.size
    except Exception as e:
        print(json.dumps({
            'tool': 'tile_image',
            'ok': False,
            'error': f'无法读取图片：{e}',
        }, ensure_ascii=False, indent=2))
        return

    # 0 = 自动重叠：按原图分辨率选择 40/80/120px
    if args.overlap == 0:
        args.overlap = auto_overlap((w, h), args.tile)

    api_key = args.api_key.strip()
    need_split = (w > args.tile or h > args.tile)

    if args.emit_images:
        print(json.dumps(
            emit_image_files(img, need_split, args.emit_images, args, src),
            ensure_ascii=False,
            indent=2,
        ))
        return

    if need_split and not args.dry_run and not api_key:
        print(json.dumps({
            'tool': 'tile_image',
            'ok': False,
            'error': f'没有 API Key：请设置环境变量 {DEFAULT_API_KEY_ENV} 或使用 --api-key',
        }, ensure_ascii=False, indent=2))
        return

    result = {
        'tool': 'tile_image',
        'ok': True,
        'image': str(src),
        'originalSize': [w, h],
        'strategy': 'whole-first-then-tiles' if need_split else 'whole-only',
        'tileSize': args.tile,
        'overlap': args.overlap,
        'whole': None,
        'tiles': [],
        'tileCount': 0,
        'dryRun': bool(args.dry_run),
    }

    # ---------- 第一步：整图识别（全局上下文） ----------
    whole_text = None
    if not args.skip_whole:
        if need_split:
            whole_img = img.copy()
            whole_img.thumbnail((args.tile, args.tile), Image.Resampling.LANCZOS)
        else:
            whole_img = img
        prompt = build_prompt(PROMPT_WHOLE, args.question)
        if args.dry_run:
            whole_text = '[dry-run] 整图已准备，未调用 API'
        else:
            whole_text = call_vision(
                to_jpeg_b64(whole_img),
                prompt,
                args.model,
                args.base_url,
                api_key,
            )
        result['whole'] = {'text': whole_text}

    # ---------- 第二步：分块识别（细节） ----------
    if need_split:
        boxes = split_tiles(img, args.tile, args.overlap)
        if args.max_tiles > 0:
            boxes = boxes[: args.max_tiles]

        save_dir = Path(args.save_tiles) if args.save_tiles else None
        if save_dir is not None:
            save_dir.mkdir(parents=True, exist_ok=True)

        for i, (x1, y1, x2, y2) in enumerate(boxes, 1):
            tile_img = img.crop((x1, y1, x2, y2))
            tw, th = tile_img.size

            if save_dir is not None:
                tile_img.save(save_dir / f'tile_{i:03d}_x{x1}_y{y1}.png')

            prompt = build_prompt(PROMPT_TILE, args.question)
            if args.dry_run:
                text = f'[dry-run] 块 {i} 已准备，未调用 API'
            else:
                text = call_vision(
                    to_jpeg_b64(tile_img),
                    prompt,
                    args.model,
                    args.base_url,
                    api_key,
                )

            result['tiles'].append({
                'index': i,
                'box': [x1, y1, x2, y2],
                'size': [tw, th],
                'text': text,
            })

        result['tileCount'] = len(result['tiles'])

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
