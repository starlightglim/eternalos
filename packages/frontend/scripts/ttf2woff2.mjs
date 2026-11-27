// Minimal TTF -> WOFF2 encoder (null transforms, Node's built-in brotli).
// Usage: node ttf2woff2.mjs in.ttf out.woff2
import { readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';

const [, , inPath, outPath] = process.argv;
const ttf = readFileSync(inPath);
const flavor = ttf.readUInt32BE(0);
const numTables = ttf.readUInt16BE(4);
const tables = [];
for (let i = 0; i < numTables; i++) {
  const o = 12 + i * 16;
  tables.push({
    tag: ttf.readUInt32BE(o),
    tagStr: ttf.toString('latin1', o, o + 4),
    offset: ttf.readUInt32BE(o + 8),
    length: ttf.readUInt32BE(o + 12),
  });
}
tables.sort((a, b) => a.tag - b.tag);

function base128(n) {
  const bytes = [];
  do { bytes.unshift(n & 0x7f); n >>>= 7; } while (n > 0);
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return bytes;
}

const dir = [];
for (const t of tables) {
  // Tag index 63 = explicit tag. glyf/loca: transform version 3 = null transform.
  const nullXform = t.tagStr === 'glyf' || t.tagStr === 'loca' ? 3 : 0;
  dir.push((nullXform << 6) | 63);
  dir.push((t.tag >>> 24) & 0xff, (t.tag >>> 16) & 0xff, (t.tag >>> 8) & 0xff, t.tag & 0xff);
  dir.push(...base128(t.length));
}
const stream = Buffer.concat(tables.map((t) => ttf.subarray(t.offset, t.offset + t.length)));
const compressed = brotliCompressSync(stream, {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT,
    [constants.BROTLI_PARAM_SIZE_HINT]: stream.length,
  },
});
const pad4 = (n) => (n + 3) & ~3;
const totalSfntSize = 12 + 16 * numTables + tables.reduce((s, t) => s + pad4(t.length), 0);
const headerLen = 48;
const length = pad4(headerLen + dir.length + compressed.length);
const out = Buffer.alloc(length);
out.writeUInt32BE(0x774f4632, 0);
out.writeUInt32BE(flavor, 4);
out.writeUInt32BE(length, 8);
out.writeUInt16BE(numTables, 12);
out.writeUInt16BE(0, 14);
out.writeUInt32BE(totalSfntSize, 16);
out.writeUInt32BE(compressed.length, 20);
out.writeUInt16BE(1, 24);
out.writeUInt16BE(0, 26);
// meta/priv offsets+lengths stay 0
Buffer.from(dir).copy(out, headerLen);
compressed.copy(out, headerLen + dir.length);
writeFileSync(outPath, out);
console.log(`${inPath} ${ttf.length}B -> ${outPath} ${out.length}B (${tables.map((t) => t.tagStr).join(',')})`);
