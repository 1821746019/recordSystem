/*!
 * tools/make-icons.js —— 生成 PWA 需要的 PNG 图标（零依赖）
 * ---------------------------------------------------------------
 * 为什么手写 PNG：项目卖点是「零运行时依赖」，不想为了几个图标引入
 * canvas / sharp / ImageMagick。这里只用 Node 内置的 zlib 手写 PNG。
 *
 * 运行：node tools/make-icons.js（或 npm run icons）
 *
 * 产物（会覆盖 icons/ 下的同名文件，记得一起提交）：
 *   icon-192.png            安卓/桌面 Chrome 的 any 图标
 *   icon-512.png            同上，高分辨率
 *   icon-maskable-512.png   安卓自适应图标（满幅背景 + 中间 72% 安全区）
 *   apple-touch-icon-180.png iOS 添加到主屏幕（iOS 会自己加圆角，所以要满幅）
 *
 * 改了配色/图形的话：改下面的 PALETTE / drawGlyph()，重跑本脚本即可。
 * icons/icon.svg 是同一套图形的矢量版（favicon 用），改的时候一起改。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var OUT_DIR = path.join(__dirname, '..', 'icons');

/* ------------------------------ 配色 ------------------------------ */

var PALETTE = {
  bgTop: [91, 124, 250],     // #5b7cfa
  bgBottom: [63, 91, 224],   // #3f5be0
  body: [27, 42, 99],        // #1b2a63
  slot: [11, 19, 56],        // #0b1338
  paper: [255, 255, 255],
  line: [185, 198, 240]      // #b9c6f0
};

/* --------------------------- PNG 编码 ---------------------------- */

var CRC_TABLE = (function () {
  var table = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var typeBuf = Buffer.from(type, 'ascii');
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA 像素数组 => PNG 文件内容 */
function encodePNG(width, height, rgba) {
  var stride = width * 4;
  var raw = Buffer.alloc((stride + 1) * height);
  for (var y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                                  // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: truecolor + alpha
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --------------------------- 绘图原语 ---------------------------- */

/** 带 alpha 的像素混合（src over dst），坐标以像素为单位 */
function blend(buf, W, x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= W || y >= W || alpha <= 0) return;
  var i = (y * W + x) * 4;
  var sa = alpha * (color[3] === undefined ? 1 : color[3] / 255);
  if (sa <= 0) return;
  var da = buf[i + 3] / 255;
  var outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  for (var c = 0; c < 3; c++) {
    buf[i + c] = Math.round((color[c] * sa + buf[i + c] * da * (1 - sa)) / outA);
  }
  buf[i + 3] = Math.round(outA * 255);
}

/** 圆角矩形：坐标与半径都是「像素」，覆盖率用 4×4 超采样近似 */
function roundRect(buf, W, x0, y0, x1, y1, r, color) {
  var SS = 4;
  var r2 = r * r;
  var xa = Math.max(0, Math.floor(x0)), xb = Math.min(W - 1, Math.ceil(x1));
  var ya = Math.max(0, Math.floor(y0)), yb = Math.min(W - 1, Math.ceil(y1));
  for (var y = ya; y <= yb; y++) {
    for (var x = xa; x <= xb; x++) {
      var hit = 0;
      for (var sy = 0; sy < SS; sy++) {
        for (var sx = 0; sx < SS; sx++) {
          var px = x + (sx + 0.5) / SS;
          var py = y + (sy + 0.5) / SS;
          if (px < x0 || px > x1 || py < y0 || py > y1) continue;
          var cx = Math.min(Math.max(px, x0 + r), x1 - r);
          var cy = Math.min(Math.max(py, y0 + r), y1 - r);
          var dx = px - cx, dy = py - cy;
          if (dx * dx + dy * dy <= r2) hit++;
        }
      }
      if (hit) blend(buf, W, x, y, color, hit / (SS * SS));
    }
  }
}

/* ---------------------------- 图形 ------------------------------ */

/**
 * 画「打印机」图形。
 * @param {Number} W      画布边长（像素）
 * @param {Number} scale  图形占画布的比例（maskable 要留安全区，给小一点）
 * @param {Boolean} bleed 是否满幅（true 时背景铺满，false 时留透明圆角）
 */
function draw(W, scale, bleed) {
  var buf = Buffer.alloc(W * W * 4);   // 全透明

  // 1) 背景：竖向渐变
  for (var y = 0; y < W; y++) {
    var t = W > 1 ? y / (W - 1) : 0;
    var col = [
      Math.round(PALETTE.bgTop[0] + (PALETTE.bgBottom[0] - PALETTE.bgTop[0]) * t),
      Math.round(PALETTE.bgTop[1] + (PALETTE.bgBottom[1] - PALETTE.bgTop[1]) * t),
      Math.round(PALETTE.bgTop[2] + (PALETTE.bgBottom[2] - PALETTE.bgTop[2]) * t)
    ];
    for (var x = 0; x < W; x++) {
      var inside = true;
      if (!bleed) {
        // 非满幅：圆角 22%
        var r = W * 0.22;
        var cx = Math.min(Math.max(x + 0.5, r), W - r);
        var cy = Math.min(Math.max(y + 0.5, r), W - r);
        var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        inside = dx * dx + dy * dy <= r * r;
      }
      if (inside) {
        var i = (y * W + x) * 4;
        buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255;
      }
    }
  }

  // 2) 图形：以画布中心为原点，按 scale 缩放
  var u = W * scale / 100 / 100;     // 1 个「百分比单位」= 多少像素（scale 是整百分比）
  var ox = W / 2, oy = W / 2;
  function X(p) { return ox + (p - 50) * u; }
  function Y(p) { return oy + (p - 50) * u; }
  function rect(x0, y0, x1, y1, r, color) {
    roundRect(buf, W, X(x0), Y(y0), X(x1), Y(y1), r * u, color);
  }

  rect(30, 17, 70, 34, 1.5, PALETTE.paper);      // 进纸
  rect(19, 33, 81, 63.5, 5, PALETTE.body);       // 机身
  rect(27, 40.5, 73, 45.5, 1, PALETTE.slot);     // 出纸口
  rect(28.5, 60, 71.5, 81.5, 1.5, PALETTE.paper); // 出纸
  rect(33, 65.5, 67, 67.5, 0.8, PALETTE.line);   // 纸上的三行字
  rect(33, 69.5, 60, 71.5, 0.8, PALETTE.line);
  rect(33, 73.5, 64, 75.5, 0.8, PALETTE.line);

  return buf;
}

/* ---------------------------- 输出 ------------------------------ */

var JOBS = [
  { file: 'icon-192.png', size: 192, scale: 86, bleed: false },
  { file: 'icon-512.png', size: 512, scale: 86, bleed: false },
  { file: 'icon-maskable-512.png', size: 512, scale: 72, bleed: true },
  { file: 'apple-touch-icon-180.png', size: 180, scale: 84, bleed: true }
];

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

JOBS.forEach(function (job) {
  var buf = draw(job.size, job.scale, job.bleed);
  var png = encodePNG(job.size, job.size, buf);
  var out = path.join(OUT_DIR, job.file);
  fs.writeFileSync(out, png);
  console.log('  ' + job.file.padEnd(26) + job.size + '×' + job.size +
    '  ' + (png.length / 1024).toFixed(1) + ' KB');
});

console.log('图标已生成 → icons/');
