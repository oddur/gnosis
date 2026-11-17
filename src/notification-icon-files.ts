/**
 * PNG files of the notification event icons for Windows and Linux, rendered once per kind and kept in the app's
 * data folder. Electron's notification `icon` takes a file path. A failure only means no icon.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { renderIcon } from '../lib/notification-icons';
import type { NotificationKind } from '../lib/notification-routing';

/** Bumped when the drawing changes, so old files are not reused. */
export const ICON_VERSION = 1;
export const ICON_SIZE = 64;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** An 8-bit RGBA PNG. */
export function encodePng(pixels: Uint8Array, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    // Filter type 0 (none) for every row.
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** The icon file for each kind, written on first use. */
export function createNotificationIcons(directory: string) {
  const paths = new Map<NotificationKind, string | null>();
  return (kind: NotificationKind): string | undefined => {
    const known = paths.get(kind);
    if (known !== undefined) return known ?? undefined;
    const file = path.join(directory, `v${ICON_VERSION}-${kind}.png`);
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(directory, { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, encodePng(renderIcon(kind, ICON_SIZE), ICON_SIZE, ICON_SIZE));
        fs.renameSync(temporary, file);
      }
      paths.set(kind, file);
      return file;
    } catch (error) {
      console.warn('[notifications] Could not write the notification icon:', error instanceof Error ? error.message : error);
      paths.set(kind, null);
      return undefined;
    }
  };
}
