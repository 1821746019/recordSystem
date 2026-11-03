/*!
 * tools/render-emoji-icon.js —— 把 emoji 矢量稿烤成 PNG 图标（对比用）
 * ---------------------------------------------------------------
 * 为什么要绕一圈浏览器：
 *   系统 emoji 字体是位图（安卓 Noto Color Emoji 只有 136px），放大到 512 会糊；
 *   而 SVG 矢量稿可以在浏览器里按目标尺寸**原生栅格化**，边缘干净。
 *
 * 流程：
 *   1. 起一个本地 HTTP 服务，把 Twemoji 的 printer.svg 和一个绘制页面发出去；
 *   2. 浏览器用 canvas 把 SVG 画成 1024×1024，把 RGBA 原样 POST 回来；
 *   3. Node 侧按 alpha 包围盒裁切、缩放、合成到不同背景上，输出 PNG。
 *
 * 用法：
 *   node tools/render-emoji-icon.js serve     # 起服务，浏览器访问 http://localhost:8099
 *   node tools/render-emoji-icon.js compose   # 用 .tmp/emoji.raw 出对比图（只看不改）
 *   node tools/render-emoji-icon.js apply     # 用 .tmp/emoji.raw 覆盖 icons/ 的正式图标
 *
 * 产物：
 *   .tmp/preview/   emoji-blue-512.png / emoji-white-512.png / compare.png（对比图，不入库）
 *   icons/          icon-192 / icon-512 / icon-maskable-512 / apple-touch-icon-180 / icon.svg
 *
 * ⚠️ 图形来自 Twemoji（CC-BY 4.0），正式采用需保留署名：脚本会把许可证写到
 *    icons/twemoji.LICENSE，README 的「许可」一节也有说明。
 */
'use strict';

var fs = require('fs');
var http = require('http');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.join(__dirname, '..');
var TMP = path.join(ROOT, '.tmp');
var OUT = path.join(TMP, 'preview');
var SVG_PATH = path.join(TMP, 'twemoji-printer.svg');
var RAW_PATH = path.join(TMP, 'emoji.raw');
var SIZE = 1024;
var PORT = 8099;

/* --------------------------- PNG 编码 --------------------------- */

var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var t = Buffer.from(type, 'ascii');
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(w, h, rgba) {
  var stride = w * 4;
  var raw = Buffer.alloc((stride + 1) * h);
  for (var y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 只解码本项目自己生成的 PNG（全 filter 0），用于把旧图标放进对比图 */
function decodeOwnPNG(file) {
  var b = fs.readFileSync(file);
  var w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  var p = 8, idat = [];
  while (p < b.length) {
    var len = b.readUInt32BE(p);
    var type = b.slice(p + 4, p + 8).toString('ascii');
    if (type === 'IDAT') idat.push(b.slice(p + 8, p + 8 + len));
    p += 12 + len;
  }
  var raw = zlib.inflateSync(Buffer.concat(idat));
  var stride = w * 4;
  var out = Buffer.alloc(w * h * 4);
  for (var y = 0; y < h; y++) {
    // 我们自己的编码器只写 filter 0
    raw.copy(out, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { w: w, h: h, data: out };
}

/* --------------------------- 绘制 / 合成 --------------------------- */

function sampleBilinear(src, x, y) {
  var x0 = Math.floor(x), y0 = Math.floor(y);
  var fx = x - x0, fy = y - y0;
  var acc = [0, 0, 0, 0];
  for (var dy = 0; dy < 2; dy++) {
    for (var dx = 0; dx < 2; dx++) {
      var px = Math.min(SIZE - 1, Math.max(0, x0 + dx));
      var py = Math.min(SIZE - 1, Math.max(0, y0 + dy));
      var i = (py * SIZE + px) * 4;
      var a = src[i + 3] / 255;
      var wgt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      acc[0] += src[i] * a * wgt;
      acc[1] += src[i + 1] * a * wgt;
      acc[2] += src[i + 2] * a * wgt;
      acc[3] += a * wgt;
    }
  }
  if (acc[3] <= 0) return null;
  return [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3], acc[3]];
}

function blend(buf, i, rgb, a) {
  var da = buf[i + 3] / 255;
  var outA = a + da * (1 - a);
  if (outA <= 0) return;
  for (var c = 0; c < 3; c++) {
    buf[i + c] = Math.round((rgb[c] * a + buf[i + c] * da * (1 - a)) / outA);
  }
  buf[i + 3] = Math.round(outA * 255);
}

/**
 * 合成一个图标
 * @param {Object} o { size, bg:'blue'|'white', rounded:Boolean, contentRatio:Number }
 */
function makeIcon(src, bbox, o) {
  var S = o.size;
  var buf = Buffer.alloc(S * S * 4);
  var r = o.rounded ? S * 0.22 : 0;

  // 背景
  for (var y = 0; y < S; y++) {
    var t = y / (S - 1);
    var col = o.bg === 'blue'
      ? [91 + (63 - 91) * t, 124 + (91 - 124) * t, 250 + (224 - 250) * t]
      : [247, 248, 252];
    for (var x = 0; x < S; x++) {
      var inside = true;
      if (r > 0) {
        var cx = Math.min(Math.max(x + 0.5, r), S - r);
        var cy = Math.min(Math.max(y + 0.5, r), S - r);
        inside = (x + 0.5 - cx) * (x + 0.5 - cx) + (y + 0.5 - cy) * (y + 0.5 - cy) <= r * r;
      }
      if (!inside) continue;
      var i = (y * S + x) * 4;
      buf[i] = Math.round(col[0]);
      buf[i + 1] = Math.round(col[1]);
      buf[i + 2] = Math.round(col[2]);
      buf[i + 3] = 255;
    }
  }

  // emoji 等比缩放居中（按 alpha 包围盒对齐，视觉更稳）
  var scale = (S * o.contentRatio) / bbox.h;
  var dw = bbox.w * scale, dh = bbox.h * scale;
  var ox = (S - dw) / 2, oy = (S - dh) / 2;

  for (var dy2 = 0; dy2 < S; dy2++) {
    var sy = (dy2 - oy) / scale + bbox.y0;
    if (sy < bbox.y0 - 1 || sy > bbox.y1 + 1) continue;
    for (var dx2 = 0; dx2 < S; dx2++) {
      var sx = (dx2 - ox) / scale + bbox.x0;
      if (sx < bbox.x0 - 1 || sx > bbox.x1 + 1) continue;
      var px = sampleBilinear(src, sx, sy);
      if (!px) continue;
      var idx = (dy2 * S + dx2) * 4;
      blend(buf, idx, px, px[3]);
    }
  }

  return buf;
}

function downscale(buf, from, to) {
  var out = Buffer.alloc(to * to * 4);
  var k = from / to;
  for (var y = 0; y < to; y++) {
    for (var x = 0; x < to; x++) {
      var acc = [0, 0, 0, 0];
      var n = 0;
      for (var sy = Math.floor(y * k); sy < Math.floor((y + 1) * k); sy++) {
        for (var sx = Math.floor(x * k); sx < Math.floor((x + 1) * k); sx++) {
          var i = (sy * from + sx) * 4;
          var a = buf[i + 3] / 255;
          acc[0] += buf[i] * a; acc[1] += buf[i + 1] * a; acc[2] += buf[i + 2] * a;
          acc[3] += a; n++;
        }
      }
      var o = (y * to + x) * 4;
      if (acc[3] > 0) {
        out[o] = Math.round(acc[0] / acc[3]);
        out[o + 1] = Math.round(acc[1] / acc[3]);
        out[o + 2] = Math.round(acc[2] / acc[3]);
      }
      out[o + 3] = Math.round(acc[3] / n * 255);
    }
  }
  return out;
}

/* --------------------------- 产出正式图标 --------------------------- */

/** 把 emoji 烘焙成 icons/ 下的正式图标（含矢量 favicon） */
function applyIcons() {
  var raw = fs.readFileSync(RAW_PATH);
  var bbox = alphaBBox(raw, SIZE);
  if (!bbox) {
    console.log('❌ 画布是空的，无法生成');
    process.exit(2);
  }

  var jobs = [
    { file: 'icon-192.png', size: 192, rounded: true, ratio: 0.66 },
    { file: 'icon-512.png', size: 512, rounded: true, ratio: 0.66 },
    { file: 'icon-maskable-512.png', size: 512, rounded: false, ratio: 0.52 },   // 留安全区
    { file: 'apple-touch-icon-180.png', size: 180, rounded: false, ratio: 0.62 } // iOS 自己加圆角
  ];

  jobs.forEach(function (j) {
    var buf = makeIcon(raw, bbox, {
      size: j.size, bg: 'blue', rounded: j.rounded, contentRatio: j.ratio
    });
    fs.writeFileSync(path.join(ROOT, 'icons', j.file), encodePNG(j.size, j.size, buf));
    console.log('  ' + j.file.padEnd(26) + j.size + '×' + j.size);
  });

  // 矢量 favicon：把 Twemoji 的路径内联进蓝色圆角底（浏览器标签页那个小图标）
  var svg = fs.readFileSync(SVG_PATH, 'utf8');
  var inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  var k = (512 * 0.66) / 36;              // 36 是 Twemoji 的 viewBox 边长
  var t = (512 - 36 * k) / 2;
  var out = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="打印记录系统">',
    '  <defs>',
    '    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">',
    '      <stop offset="0" stop-color="#5b7cfa"/>',
    '      <stop offset="1" stop-color="#3f5be0"/>',
    '    </linearGradient>',
    '  </defs>',
    '  <rect width="512" height="512" rx="112" fill="url(#bg)"/>',
    '  <!-- 图形来自 Twemoji（CC-BY 4.0），见 icons/twemoji.LICENSE -->',
    '  <g transform="translate(' + t.toFixed(2) + ' ' + t.toFixed(2) + ') scale(' + k.toFixed(4) + ')">',
    inner,
    '  </g>',
    '</svg>',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'icons', 'icon.svg'), out);
  console.log('  icon.svg                  矢量 favicon（内联 Twemoji 图形）');

  // 顺手更新一份许可证原文，保证署名随仓库走
  var lic = path.join(TMP, 'twemoji-license.txt');
  if (fs.existsSync(lic)) {
    fs.copyFileSync(lic, path.join(ROOT, 'icons', 'twemoji.LICENSE'));
    console.log('  icons/twemoji.LICENSE     CC-BY 4.0 原文');
  }
}

/* --------------------------- 合成全部产物 --------------------------- */

/** 求 alpha 包围盒，空图返回 null */
function alphaBBox(raw, size) {
  var x0 = size, y0 = size, x1 = 0, y1 = 0;
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      if (raw[(y * size + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function composeAll() {
  var raw = fs.readFileSync(RAW_PATH);
  if (raw.length !== SIZE * SIZE * 4) {
    console.log('❌ emoji.raw 尺寸不对：' + raw.length);
    process.exit(1);
  }

  var bbox = alphaBBox(raw, SIZE);
  if (!bbox) {
    console.log('❌ 画布是空的：emoji 没有渲染出来（这个环境缺 emoji 字体）');
    process.exit(2);
  }
  console.log('  emoji 包围盒：' + bbox.w + '×' + bbox.h + '（原图 ' + SIZE + '）');

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  var variants = [
    { file: 'emoji-blue-512.png', bg: 'blue', rounded: true, contentRatio: 0.66 },
    { file: 'emoji-white-512.png', bg: 'white', rounded: true, contentRatio: 0.66 }
  ];

  var thumbs = [];
  variants.forEach(function (v) {
    var buf = makeIcon(raw, bbox, { size: 512, bg: v.bg, rounded: v.rounded, contentRatio: v.contentRatio });
    fs.writeFileSync(path.join(OUT, v.file), encodePNG(512, 512, buf));
    thumbs.push(downscale(buf, 512, 256));
  });

  // 现有的手绘图标（512 → 256）
  var cur = decodeOwnPNG(path.join(ROOT, 'icons', 'icon-512.png'));
  thumbs.unshift(downscale(cur.data, 512, 256));

  // 横向拼一张对比图：现在的 / 蓝底 emoji / 白底 emoji
  var cell = 256, gap = 28, pad = 28;
  var W = pad * 2 + cell * 3 + gap * 2;
  var H = pad * 2 + cell;
  var out = Buffer.alloc(W * H * 4);
  for (var i = 0; i < W * H; i++) {
    out[i * 4] = 233; out[i * 4 + 1] = 237; out[i * 4 + 2] = 245; out[i * 4 + 3] = 255;
  }
  thumbs.forEach(function (t, n) {
    var ox = pad + n * (cell + gap), oy = pad;
    for (var y2 = 0; y2 < cell; y2++) {
      for (var x2 = 0; x2 < cell; x2++) {
        var si = (y2 * cell + x2) * 4;
        var a = t[si + 3] / 255;
        if (a <= 0) continue;
        var di = ((oy + y2) * W + (ox + x2)) * 4;
        for (var c = 0; c < 3; c++) {
          out[di + c] = Math.round(t[si + c] * a + out[di + c] * (1 - a));
        }
      }
    }
  });
  fs.writeFileSync(path.join(OUT, 'compare.png'), encodePNG(W, H, out));

  console.log('  已生成：' + variants.map(function (v) { return v.file; }).join(', '));
  console.log('  对比图：.tmp/preview/compare.png（左=现在的，中=emoji蓝底，右=emoji白底）');
  console.log('  尺寸：' + W + '×' + H);
}

/* ------------------------------ 服务 ------------------------------ */

var PAGE = [
  '<!doctype html><meta charset="utf-8">',
  '<body style="margin:0;background:#fff">',
  '<canvas id="c" width="1024" height="1024"></canvas>',
  '<script>',
  'var img = new Image();',
  'img.onload = function () {',
  '  var c = document.getElementById("c"), x = c.getContext("2d");',
  '  x.clearRect(0, 0, 1024, 1024);',
  '  x.drawImage(img, 62, 62, 900, 900);',
  '  var d = x.getImageData(0, 0, 1024, 1024).data;',
  '  fetch("/upload", { method: "POST", body: d }).then(function () {',
  '    document.title = "DONE";',
  '    document.body.insertAdjacentHTML("beforeend", "<p id=ok>DONE</p>");',
  '  });',
  '};',
  'img.onerror = function () { document.title = "ERR"; };',
  'img.src = "/printer.svg";',
  '</script>'
].join('\n');

function serve() {
  if (!fs.existsSync(SVG_PATH)) {
    console.log('❌ 缺少 ' + SVG_PATH);
    process.exit(1);
  }
  var server = http.createServer(function (req, res) {
    if (req.url === '/printer.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(fs.readFileSync(SVG_PATH));
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      var parts = [];
      req.on('data', function (c) { parts.push(c); });
      req.on('end', function () {
        var body = Buffer.concat(parts);
        fs.writeFileSync(RAW_PATH, body);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        console.log('  收到画布数据：' + body.length + ' 字节');
        setTimeout(function () {
          server.close();
          composeAll();
        }, 80);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  server.listen(PORT, function () {
    console.log('请用浏览器打开：http://localhost:' + PORT + '/');
  });
  setTimeout(function () {
    console.log('⏱ 60 秒内没收到画布数据，退出');
    process.exit(3);
  }, 60000);
}

var mode = process.argv[2] || 'serve';
if (mode === 'compose') composeAll();
else if (mode === 'apply') applyIcons();
else serve();
