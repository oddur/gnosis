/**
 * Event icons for notifications (#385 part 3), in the PR state icon style: the Lucide glyph the app uses, in the
 * event's status colour. In-app toasts draw the Lucide component by name. Windows and Linux desktop notifications
 * take a PNG path, so `renderIcon` rasterises the same glyph on a light disc, without a browser; main encodes and
 * caches the pixels once per kind. macOS always shows the app icon.
 *
 * Pure. The glyph outlines below are copied from lucide-react 0.574.0 (ISC licence), 24×24 units, 2-unit strokes.
 */
import type { NotificationKind } from './notification-routing';

export type NotificationIconName =
  | 'git-pull-request'
  | 'git-compare-arrows'
  | 'message-square-warning'
  | 'circle-check'
  | 'circle-x'
  | 'git-merge'
  | 'at-sign'
  | 'message-square-reply'
  | 'alarm-clock'
  | 'sparkles'
  | 'info'
  | 'inbox'
  | 'bell-ring';
export type IconTone = 'attention' | 'danger' | 'success' | 'done' | 'neutral';
export const NOTIFICATION_ICONS: Record<NotificationKind, { icon: NotificationIconName; tone: IconTone }> = {
  'review-requested': { icon: 'git-pull-request', tone: 'attention' },
  'team-review-requested': { icon: 'git-pull-request', tone: 'attention' },
  rereview: { icon: 'git-compare-arrows', tone: 'attention' },
  'changes-requested': { icon: 'message-square-warning', tone: 'danger' },
  approved: { icon: 'circle-check', tone: 'success' },
  'checks-failed': { icon: 'circle-x', tone: 'danger' },
  'ready-to-merge': { icon: 'git-merge', tone: 'success' },
  mention: { icon: 'at-sign', tone: 'attention' },
  reply: { icon: 'message-square-reply', tone: 'attention' },
  'snooze-ended': { icon: 'alarm-clock', tone: 'neutral' },
  'explanation-ready': { icon: 'sparkles', tone: 'done' },
  'update-ready': { icon: 'info', tone: 'neutral' },
  summary: { icon: 'inbox', tone: 'neutral' },
  test: { icon: 'bell-ring', tone: 'attention' },
};
/** sRGB colours for the PNGs, GitHub's light status colours, legible on light and dark notification centres. */
export const TONE_RGB: Record<IconTone, [number, number, number]> = {
  attention: [9, 105, 218],
  danger: [207, 34, 46],
  success: [26, 127, 55],
  done: [130, 80, 223],
  neutral: [89, 99, 110],
};
export const iconFor = (kind: NotificationKind) => NOTIFICATION_ICONS[kind];

type Shape =
  | ['path', string]
  | ['circle', number, number, number]
  | ['line', number, number, number, number]
  | ['polyline', string];
const SQUARE = 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z';
export const ICON_SHAPES: Record<NotificationIconName, Shape[]> = {
  'git-pull-request': [['circle', 18, 18, 3], ['circle', 6, 6, 3], ['path', 'M13 6h3a2 2 0 0 1 2 2v7'], ['line', 6, 9, 6, 21]],
  'git-compare-arrows': [['circle', 5, 6, 3], ['path', 'M12 6h5a2 2 0 0 1 2 2v7'], ['path', 'm15 9-3-3 3-3'], ['circle', 19, 18, 3], ['path', 'M12 18H7a2 2 0 0 1-2-2V9'], ['path', 'm9 15 3 3-3 3']],
  'message-square-warning': [['path', SQUARE], ['path', 'M12 15h.01'], ['path', 'M12 7v4']],
  'circle-check': [['circle', 12, 12, 10], ['path', 'm9 12 2 2 4-4']],
  'circle-x': [['circle', 12, 12, 10], ['path', 'm15 9-6 6'], ['path', 'm9 9 6 6']],
  'git-merge': [['circle', 18, 18, 3], ['circle', 6, 6, 3], ['path', 'M6 21V9a9 9 0 0 0 9 9']],
  'at-sign': [['circle', 12, 12, 4], ['path', 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8']],
  'message-square-reply': [['path', SQUARE], ['path', 'm10 8-3 3 3 3'], ['path', 'M17 14v-1a2 2 0 0 0-2-2H7']],
  'alarm-clock': [['circle', 12, 13, 8], ['path', 'M12 9v4l2 2'], ['path', 'M5 3 2 6'], ['path', 'm22 6-3-3'], ['path', 'M6.38 18.7 4 21'], ['path', 'M17.64 18.67 20 21']],
  sparkles: [
    ['path', 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z'],
    ['path', 'M20 2v4'],
    ['path', 'M22 4h-4'],
    ['circle', 4, 20, 2],
  ],
  info: [['circle', 12, 12, 10], ['path', 'M12 16v-4'], ['path', 'M12 8h.01']],
  inbox: [['polyline', '22 12 16 12 14 15 10 15 8 12 2 12'], ['path', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z']],
  'bell-ring': [
    ['path', 'M10.268 21a2 2 0 0 0 3.464 0'],
    ['path', 'M22 8c0-2.3-.8-4.3-2-6'],
    ['path', 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'],
    ['path', 'M4 2C2.8 3.7 2 5.7 2 8'],
  ],
};

type Point = [number, number];
const ARC_STEPS = 24;
const CURVE_STEPS = 16;

/** Flattens SVG path data to polylines. Supports M L H V C S Q A Z, absolute and relative. */
export function flattenPath(d: string): Point[][] {
  const tokens = d.match(/[MmLlHhVvCcSsQqAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const lines: Point[][] = [];
  let line: Point[] = [];
  let x = 0, y = 0, startX = 0, startY = 0;
  let command = '';
  let lastControl: Point | undefined;
  let i = 0;
  const number = () => Number(tokens[i++]);
  const flag = () => {
    // Arc flags may be packed without separators ("0 0 1" or "001").
    const token = tokens[i];
    if (token.length > 1 && /^[01]/.test(token)) {
      tokens[i] = token.slice(1);
      return Number(token[0]);
    }
    i++;
    return Number(token);
  };
  const push = (point: Point) => line.push(point);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) command = tokens[i++];
    const relative = command === command.toLowerCase();
    const base: Point = relative ? [x, y] : [0, 0];
    switch (command.toUpperCase()) {
      case 'M': {
        if (line.length > 1) lines.push(line);
        x = base[0] + number();
        y = base[1] + number();
        startX = x;
        startY = y;
        line = [[x, y]];
        // Further pairs are line-tos.
        command = relative ? 'l' : 'L';
        lastControl = undefined;
        break;
      }
      case 'L':
        x = base[0] + number();
        y = base[1] + number();
        push([x, y]);
        lastControl = undefined;
        break;
      case 'H':
        x = (relative ? x : 0) + number();
        push([x, y]);
        lastControl = undefined;
        break;
      case 'V':
        y = (relative ? y : 0) + number();
        push([x, y]);
        lastControl = undefined;
        break;
      case 'C':
      case 'S':
      case 'Q': {
        const kind = command.toUpperCase();
        const first: Point =
          kind === 'S'
            ? lastControl ? [2 * x - lastControl[0], 2 * y - lastControl[1]] : [x, y]
            : [base[0] + number(), base[1] + number()];
        const second: Point | undefined = kind === 'Q' ? undefined : [base[0] + number(), base[1] + number()];
        const end: Point = [base[0] + number(), base[1] + number()];
        const from: Point = [x, y];
        for (let step = 1; step <= CURVE_STEPS; step++) {
          const t = step / CURVE_STEPS, u = 1 - t;
          if (second) push([
            u ** 3 * from[0] + 3 * u * u * t * first[0] + 3 * u * t * t * second[0] + t ** 3 * end[0],
            u ** 3 * from[1] + 3 * u * u * t * first[1] + 3 * u * t * t * second[1] + t ** 3 * end[1],
          ]);
          else push([u * u * from[0] + 2 * u * t * first[0] + t * t * end[0], u * u * from[1] + 2 * u * t * first[1] + t * t * end[1]]);
        }
        lastControl = second ?? first;
        [x, y] = end;
        break;
      }
      case 'A': {
        const rx = Math.abs(number()), ry = Math.abs(number()), rotation = number();
        const large = flag(), sweep = flag();
        const end: Point = [base[0] + number(), base[1] + number()];
        for (const point of arcPoints([x, y], end, rx, ry, rotation, large === 1, sweep === 1)) push(point);
        [x, y] = end;
        lastControl = undefined;
        break;
      }
      case 'Z':
        push([startX, startY]);
        x = startX;
        y = startY;
        lastControl = undefined;
        break;
      default:
        // Unknown data: stop rather than loop.
        i = tokens.length;
    }
  }
  if (line.length > 1) lines.push(line);
  return lines;
}

/** An SVG elliptical arc as points, by the endpoint-to-centre conversion of the SVG specification (F.6.5). */
function arcPoints(from: Point, to: Point, rx: number, ry: number, degrees: number, large: boolean, sweep: boolean): Point[] {
  if (!rx || !ry) return [to];
  const phi = (degrees * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (from[0] - to[0]) / 2, dy = (from[1] - to[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const scale = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (scale > 1) {
    rx *= Math.sqrt(scale);
    ry *= Math.sqrt(scale);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (factor * rx * y1) / ry, cy1 = (-factor * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2, cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil((ARC_STEPS * Math.abs(delta)) / (2 * Math.PI)));
  const points: Point[] = [];
  for (let step = 1; step <= steps; step++) {
    const t = start + (delta * step) / steps;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    points.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  points[points.length - 1] = to;
  return points;
}

/** The polylines of one icon, in its 24-unit space. */
export function iconPolylines(name: NotificationIconName): Point[][] {
  return ICON_SHAPES[name].flatMap((shape): Point[][] => {
    if (shape[0] === 'path') return flattenPath(shape[1]);
    if (shape[0] === 'line') return [[[shape[1], shape[2]], [shape[3], shape[4]]]];
    if (shape[0] === 'polyline') {
      const values = shape[1].trim().split(/[\s,]+/).map(Number);
      const points: Point[] = [];
      for (let n = 0; n + 1 < values.length; n += 2) points.push([values[n], values[n + 1]]);
      return [points];
    }
    const [, cx, cy, r] = shape;
    const points: Point[] = [];
    for (let step = 0; step <= ARC_STEPS * 2; step++) {
      const t = (step / (ARC_STEPS * 2)) * 2 * Math.PI;
      points.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
    return [points];
  });
}

function segmentDistance(px: number, py: number, a: Point, b: Point): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const length = vx * vx + vy * vy;
  const t = length ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / length)) : 0;
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

/**
 * RGBA pixels of a notification icon: a light disc with the event glyph stroked in its colour, antialiased.
 * Round caps and joins come from measuring the distance to each segment.
 */
export function renderIcon(kind: NotificationKind, size = 64): Uint8Array {
  const { icon, tone } = iconFor(kind);
  const [r, g, b] = TONE_RGB[tone];
  const pixels = new Uint8Array(size * size * 4);
  const lines = iconPolylines(icon);
  // The glyph fills 62% of the disc, as a 24-unit icon in a padded badge.
  const scale = (size * 0.62) / 24;
  const offset = (size - 24 * scale) / 2;
  const half = (2 * scale) / 2;
  const segments: [Point, Point][] = [];
  for (const line of lines)
    for (let n = 1; n < line.length; n++)
      segments.push([
        [offset + line[n - 1][0] * scale, offset + line[n - 1][1] * scale],
        [offset + line[n][0] * scale, offset + line[n][1] * scale],
      ]);
  const radius = size / 2 - 0.5;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const cx = px + 0.5, cy = py + 0.5;
      const disc = Math.max(0, Math.min(1, radius - Math.hypot(cx - size / 2, cy - size / 2) + 0.5));
      if (!disc) continue;
      let distance = Infinity;
      for (const [a, c] of segments) distance = Math.min(distance, segmentDistance(cx, cy, a, c));
      const ink = Math.max(0, Math.min(1, half - distance + 0.5));
      const index = (py * size + px) * 4;
      // A thin ring keeps the white disc visible on a white notification centre.
      const ring = Math.max(0, Math.min(1, 1.2 - Math.abs(radius - 0.6 - Math.hypot(cx - size / 2, cy - size / 2)))) * 0.18;
      const base = 255 * (1 - ring) + 120 * ring;
      pixels[index] = Math.round(base * (1 - ink) + r * ink);
      pixels[index + 1] = Math.round(base * (1 - ink) + g * ink);
      pixels[index + 2] = Math.round(base * (1 - ink) + b * ink);
      pixels[index + 3] = Math.round(255 * disc);
    }
  return pixels;
}
