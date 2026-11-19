import { fileIcon } from '../lib/file-icons';

/**
 * A file's type icon, in the variant for the app theme. `surface="dark"` always uses the dark variant, for surfaces that
 * stay dark in both themes, such as the code-tier file header.
 */
export function FileTypeIcon({ filePath, surface }: { filePath: string; surface?: 'dark' }) {
  const icon = fileIcon(filePath);
  if (surface === 'dark')
    return (
      <span className="file-type-icon inline-block size-4 shrink-0" data-file-icon={icon.name} aria-hidden="true">
        <img src={icon.dark} alt="" width={16} height={16} className="block" />
      </span>
    );
  return (
    <span className="file-type-icon inline-block size-4 shrink-0" data-file-icon={icon.name} aria-hidden="true">
      <img src={icon.light} alt="" width={16} height={16} className="block dark:hidden" />
      <img src={icon.dark} alt="" width={16} height={16} className="hidden dark:block" />
    </span>
  );
}
