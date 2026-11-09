// Make the tray icons as PNG files. The script has no dependencies.
// The icon is a dashed rectangle with solid corners.
// On macOS, a file name that ends in "Template" tells the system to tint the icon.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]));
    rows.push(rgba.subarray(y * size * 4, (y + 1) * size * 4));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size, color) {
  const s = size / 16; // scale from the 16 px design
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = color[0];
    buf[i + 1] = color[1];
    buf[i + 2] = color[2];
    buf[i + 3] = 255;
  };
  const left = Math.round(1 * s), right = Math.round(15 * s) - 1;
  const top = Math.round(3 * s), bottom = Math.round(13 * s) - 1;
  const t = Math.max(1, Math.round(1.5 * s)); // line thickness
  const corner = Math.round(4 * s);
  const dash = Math.round(2 * s);
  const onLine = (pos, start, end) =>
    pos - start < corner || end - pos < corner || Math.floor((pos - start) / dash) % 2 === 0;
  for (let x = left; x <= right; x++) {
    if (!onLine(x, left, right)) continue;
    for (let k = 0; k < t; k++) { set(x, top + k); set(x, bottom - k); }
  }
  for (let y = top; y <= bottom; y++) {
    if (!onLine(y, top, bottom)) continue;
    for (let k = 0; k < t; k++) { set(left + k, y); set(right - k, y); }
  }
  return png(size, buf);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
// macOS: black template images. The system changes the color for light and dark menu bars.
fs.writeFileSync(path.join(out, 'trayTemplate.png'), draw(16, [0, 0, 0]));
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), draw(32, [0, 0, 0]));
// Windows: a red icon. Red shows on light and dark taskbars.
fs.writeFileSync(path.join(out, 'tray-win.png'), draw(32, [255, 59, 48]));
console.log('Icons written to', out);
