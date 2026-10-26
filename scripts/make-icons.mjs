// Turns the icon artwork (white background) into a transparent, trimmed, square
// icon: build-resources/icon.png (1024 px) and icon.ico (16 to 256 px).
//   node scripts/make-icons.mjs [source]     (default: apps/desktop/build-resources/icon-source.webp)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = path.join(root, 'apps', 'desktop', 'build-resources');
const source = process.argv[2] ?? path.join(outDir, 'icon-source.webp');

// Remove the white background: shapes stay opaque; only near-white edge pixels become
// partly transparent, "un-multiplied" so they keep the shape colour over dark taskbars.
const EDGE = 48;
const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < data.length; i += 4) {
  const r = data[i], g = data[i + 1], b = data[i + 2], a0 = data[i + 3] / 255;
  const alpha = Math.min(1, (255 - Math.min(r, g, b)) / EDGE);
  if (alpha <= 0.04) {
    data[i + 3] = 0;
    continue;
  }
  data[i] = Math.round(255 - (255 - r) / alpha);
  data[i + 1] = Math.round(255 - (255 - g) / alpha);
  data[i + 2] = Math.round(255 - (255 - b) / alpha);
  data[i + 3] = Math.round(alpha * a0 * 255);
}
const transparent = await sharp(data, { raw: info }).png().toBuffer();
const trimmed = await sharp(transparent).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
const side = Math.round(Math.max(trimmed.info.width, trimmed.info.height) * 1.08);
const square = await sharp({ create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: trimmed.data, gravity: 'centre' }])
  .png()
  .toBuffer();

fs.writeFileSync(path.join(outDir, 'icon.png'), await sharp(square).resize(1024, 1024).png().toBuffer());

// ICO with PNG-compressed images (supported since Windows Vista).
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((s) => sharp(square).resize(s, s, { kernel: 'lanczos3' }).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  header.writeUInt8(s >= 256 ? 0 : s, e);
  header.writeUInt8(s >= 256 ? 0 : s, e + 1);
  header.writeUInt8(0, e + 2);
  header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(images[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, ...images]));
// Small PNG for the tray (the window and installer use the .ico).
fs.writeFileSync(path.join(outDir, 'tray.png'), await sharp(square).resize(32, 32, { kernel: 'lanczos3' }).png().toBuffer());
console.log(`[icons] ${side}px square from ${path.basename(source)} -> icon.png, icon.ico (${sizes.join(', ')}), tray.png`);
