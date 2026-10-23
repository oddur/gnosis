import { fileIcon } from '../lib/file-icons';

export function FileTypeIcon({ filePath }: { filePath: string }) {
  const icon = fileIcon(filePath);
  return (
    <span className="file-type-icon inline-block size-4 shrink-0" data-file-icon={icon.name} aria-hidden="true">
      <img src={icon.light} alt="" width={16} height={16} className="block dark:hidden" />
      <img src={icon.dark} alt="" width={16} height={16} className="hidden dark:block" />
    </span>
  );
}
