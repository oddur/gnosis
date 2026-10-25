/** Git LFS v1 pointers are small UTF-8 files, never the resource itself. */
export interface LfsPointer {
  oid: string;
  size: number;
}
export const LFS_VERSION = 'version https://git-lfs.github.com/spec/v1';
export function parseLfsPointer(content: string): LfsPointer | undefined {
  if (content.length > 1024) return;
  const lines = content.replace(/\r\n/g, '\n').trimEnd().split('\n');
  if (lines[0] !== LFS_VERSION) return;
  const oid = lines.find((line) => /^oid sha256:[a-f0-9]{64}$/.test(line))?.slice(11);
  const sizeLine = lines.find((line) => /^size \d+$/.test(line));
  if (
    !oid ||
    !sizeLine ||
    lines.filter((line) => line.startsWith('oid ')).length !== 1 ||
    lines.filter((line) => line.startsWith('size ')).length !== 1
  )
    return;
  const size = Number(sizeLine.slice(5));
  if (!Number.isSafeInteger(size) || size < 0) return;
  return { oid, size };
}
export function lfsSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
