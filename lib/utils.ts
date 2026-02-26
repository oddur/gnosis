import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ReviewHistoryEntry } from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function parseRepoRef(prUrl: string): string {
  const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return match ? `${match[1]}#${match[2]}` : prUrl;
}

export interface PRGroup {
  prUrl: string;
  repoRef: string;
  prTitle: string;
  author: string;
  latestReview: ReviewHistoryEntry;
  reviews: ReviewHistoryEntry[];
}

export function groupReviewsByPR(history: ReviewHistoryEntry[]): PRGroup[] {
  const map = new Map<string, ReviewHistoryEntry[]>();
  for (const entry of history) {
    const list = map.get(entry.prUrl);
    if (list) list.push(entry);
    else map.set(entry.prUrl, [entry]);
  }

  const groups: PRGroup[] = [];
  for (const [prUrl, reviews] of map) {
    reviews.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
    const latest = reviews[0];
    groups.push({
      prUrl,
      repoRef: parseRepoRef(prUrl),
      prTitle: latest.prTitle,
      author: latest.author,
      latestReview: latest,
      reviews,
    });
  }

  groups.sort((a, b) => new Date(b.latestReview.savedAt).getTime() - new Date(a.latestReview.savedAt).getTime());
  return groups;
}
