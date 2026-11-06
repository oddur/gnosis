import { workbenchIcons } from '../lib/interface-icons';

/** Adjacent text or the control's accessible name supplies the meaning. */
export function WorkbenchIcon({ name, size = 16, className = '' }: {
  name: keyof typeof workbenchIcons;
  size?: number;
  className?: string;
}) {
  const Icon = workbenchIcons[name];
  return <Icon size={size} className={`workbench-feature-icon ${className}`} aria-hidden="true" />;
}
