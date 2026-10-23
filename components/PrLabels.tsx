import type { CSSProperties } from 'react';
import type { ReviewMember } from '../lib/workbench';
import type { PrLabel } from '../lib/types';

function colors(color?: string): CSSProperties | undefined {
  if (!color || !/^[0-9a-f]{6}$/i.test(color)) return;
  const rgb = [0, 2, 4].map((offset) => {
    const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  // Choose the higher-contrast text color for the exact GitHub background.
  const foreground = (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
  return {
    backgroundColor: `#${color}`,
    color: foreground,
    borderColor: `color-mix(in srgb, ${foreground} 22%, #${color})`,
  };
}
export function PrLabels({
  members,
  limit,
}: {
  members: Pick<ReviewMember, 'labels' | 'labelDetails' | 'repo' | 'number'>[];
  limit?: number;
}) {
  const labels = new Map<string, PrLabel & { sources: string[] }>();
  for (const member of members)
    for (const name of member.labels) {
      const detail = member.labelDetails?.find((label) => label.name === name);
      const key = name.toLowerCase();
      const source = `${member.repo} #${member.number}`;
      const existing = labels.get(key);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        // A stack can span repos with different colors for the same label name.
        if (existing.color !== detail?.color) existing.color = undefined;
      } else labels.set(key, { ...detail, name, sources: [source] });
    }
  const all = [...labels.values()];
  if (!all.length) return null;
  const visible = limit === undefined ? all : all.slice(0, limit);
  const hidden = all.slice(visible.length);
  const describe = (label: (typeof all)[number]) =>
    [label.name, label.description, members.length > 1 ? `On ${label.sources.join(', ')}` : undefined]
      .filter(Boolean)
      .join(' — ');
  return (
    <span className="pr-labels" role="group" aria-label={members.length > 1 ? 'Labels across this stack' : 'PR labels'}>
      {visible.map((label) => (
        <span key={label.name} className="pr-label" style={colors(label.color)} title={describe(label)}>
          {label.name}
        </span>
      ))}
      {!!hidden.length && (
        <span className="pr-label-more" title={hidden.map(describe).join('\n')}>
          <span aria-hidden="true">+{hidden.length}</span>
          <span className="sr-only">
            {hidden.length} more labels: {hidden.map((label) => label.name).join(', ')}
          </span>
        </span>
      )}
    </span>
  );
}
