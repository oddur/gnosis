/**
 * The browser suite's Overview fixtures (`tests/fixtures/overview.ts`) in Node, for unit tests: the same synthetic
 * days (the default day, a light day, and the real shapes real4–real7 and stacks5), with the window, location and
 * preferences stubbed. Nothing reaches GitHub.
 */
import { installOverviewFixture } from './overview';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../../lib/workbench';
import type { QueueSignalRequest, QueueSignals } from '../../lib/queue-signals';

export const FIXTURE_LOGIN = 'oddur';
export type OverviewFixtureName = 'default' | 'light' | 'real4' | 'real5' | 'real6' | 'real7' | 'stacks5';
export const OVERVIEW_FIXTURES: readonly OverviewFixtureName[] = ['default', 'light', 'real4', 'real5', 'real6', 'real7', 'stacks5'];

type FixtureControls = Record<string, (...args: unknown[]) => unknown>;

/** Builds one fixture day: its queue items and the status GitHub would report for each PR. */
export async function overviewFixture(name: OverviewFixtureName): Promise<{ items: QueueItem[]; status: Map<string, QueueSignals>; signals: (member: ReviewMember) => QueueSignals | undefined }> {
  const scope = globalThis as unknown as Record<string, unknown>;
  const events = new EventTarget();
  scope.window ??= {};
  const win = scope.window as Record<string, unknown>;
  win.dispatchEvent = (event: Event) => events.dispatchEvent(event);
  win.electronAPI = { loadPreferences: () => Promise.resolve({ repositorySettings: {} }) };
  scope.location ??= { search: '' };
  const items: QueueItem[] = [];
  const mocks: Record<string, unknown> = { workbenchQueue: () => Promise.resolve({ items } as unknown as WorkbenchQueue) };
  installOverviewFixture(mocks, items);
  const controls = win.fixtureOverview as FixtureControls;
  if (name === 'light') controls.only([311, 321, 323, 302]);
  else if (name !== 'default') controls[name]();
  const members = items.flatMap((item) => item.subject.members);
  const answers = (await (mocks.getQueueSignals as (requests: QueueSignalRequest[]) => Promise<QueueSignals[]>)(
    members.map((member) => ({ url: member.url, headSha: member.headSha }) as QueueSignalRequest)
  ));
  const status = new Map(answers.map((value) => [value.url, value]));
  return { items, status, signals: (member) => status.get(member.url) };
}
