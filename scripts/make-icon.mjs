// Generate assets/launcher.ico — a 256x256 PNG-based ICO with a DeepSeek-blue
// rounded square and a white power glyph. Run once: `node scripts/make-icon.mjs`.
// The resulting file ships as the desktop shortcut icon; the generator is not
// part of the published package.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SIZE = 256
const cx = SIZE / 2
const cy = SIZE / 2

const BLUE = [0x4d, 0x6b, 0xfe, 0xff]
const WHITE = [0xff, 0xff, 0xff, 0xff]
const NONE = [0x00, 0x00, 0x00, 0x00]

// SDF for a centered rounded square (halfW=halfH=112, radius 56).
function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x - cx) - (half - r)
  const qy = Math.abs(y - cy) - (half - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

function pixel(x, y) {
  if (sdRoundRect(x, y, 112, 56) > 0) return NONE
  const d = Math.hypot(x - cx, y - cy)
  // White ring.
  if (d >= 54 && d <= 70) return WHITE
  // White vertical bar (the power glyph stem), top half.
  if (x >= 121 && x <= 135 && y >= 44 && y <= 128) return WHITE
  return BLUE
}

// Build raw RGBA scanlines (each prefixed with filter byte 0).
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
let off = 0
for (let y = 0; y < SIZE; y++) {
  raw[off++] = 0 // filter type none
  for (let x = 0; x < SIZE; x++) {
    const p = pixel(x + 0.5, y + 0.5)
    raw[off++] = p[0]
    raw[off++] = p[1]
    raw[off++] = p[2]
    raw[off++] = p[3]
  }
}

// CRC32 (IEEE).
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td), 0)
  return Buffer.concat([len, td, crc])
}

// PNG pieces.
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0) // width
ihdr.writeUInt32BE(SIZE, 4) // height
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

// Wrap the PNG as a single-image ICO (256x256, PNG-compressed).
const icoHeader = Buffer.alloc(6)
icoHeader.writeUInt16LE(0, 0) // reserved
icoHeader.writeUInt16LE(1, 2) // type: icon
icoHeader.writeUInt16LE(1, 4) // count
const entry = Buffer.alloc(16)
entry[0] = 0 // width 256
entry[1] = 0 // height 256
entry[2] = 0 // colors
entry[3] = 0 // reserved
entry.writeUInt16LE(1, 4) // planes
entry.writeUInt16LE(32, 6) // bpp
entry.writeUInt32LE(png.length, 8) // size
entry.writeUInt32LE(22, 12) // offset (6+16)
const ico = Buffer.concat([icoHeader, entry, png])

const out = join(root, 'assets', 'launcher.ico')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, ico)
console.log('wrote ' + out + ' (' + ico.length + ' bytes)')
