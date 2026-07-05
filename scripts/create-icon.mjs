import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const size = 256;
const output = resolve("apps/desktop/src-tauri/icons/icon.png");
const rgba = Buffer.alloc(size * size * 4);

function putPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) {
    return;
  }

  const index = (y * size + x) * 4;
  rgba[index] = color[0];
  rgba[index + 1] = color[1];
  rgba[index + 2] = color[2];
  rgba[index + 3] = color[3];
}

function fillRect(x, y, width, height, color) {
  for (let row = y; row < y + height; row += 1) {
    for (let col = x; col < x + width; col += 1) {
      putPixel(col, row, color);
    }
  }
}

function fillRoundRect(x, y, width, height, radius, color) {
  const right = x + width - 1;
  const bottom = y + height - 1;

  for (let row = y; row <= bottom; row += 1) {
    for (let col = x; col <= right; col += 1) {
      const dx = col < x + radius ? x + radius - col : col > right - radius ? col - (right - radius) : 0;
      const dy = row < y + radius ? y + radius - row : row > bottom - radius ? row - (bottom - radius) : 0;
      if (dx * dx + dy * dy <= radius * radius) {
        putPixel(col, row, color);
      }
    }
  }
}

function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

fillRect(0, 0, size, size, [31, 41, 51, 255]);
fillRoundRect(38, 34, 180, 188, 24, [25, 33, 42, 255]);
fillRoundRect(56, 42, 142, 178, 18, [248, 250, 252, 255]);
fillRoundRect(74, 68, 88, 14, 7, [48, 180, 143, 255]);
fillRoundRect(74, 98, 96, 10, 5, [107, 114, 128, 255]);
fillRoundRect(74, 122, 78, 10, 5, [107, 114, 128, 255]);
fillRoundRect(74, 146, 102, 10, 5, [107, 114, 128, 255]);
fillRoundRect(74, 170, 64, 10, 5, [48, 180, 143, 255]);
fillRoundRect(168, 188, 42, 42, 12, [48, 180, 143, 255]);

const raw = Buffer.alloc((size * 4 + 1) * size);
for (let row = 0; row < size; row += 1) {
  raw[row * (size * 4 + 1)] = 0;
  rgba.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
header[10] = 0;
header[11] = 0;
header[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  makeChunk("IHDR", header),
  makeChunk("IDAT", deflateSync(raw)),
  makeChunk("IEND", Buffer.alloc(0))
]);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, png);
console.log(`Wrote ${output}`);
