// Runs comparisons off the extension host thread. Referenced files are read by the host,
// which knows what may be read; see runner.ts.
import { parentPort } from 'worker_threads';
import { compare, type CompareOptions } from './core';

export type ToWorker =
  | { type: 'compare'; job: number; old: { text: string; path: string }; new: { text: string; path: string }; options?: CompareOptions }
  | { type: 'read-result'; id: number; text?: string };

export type FromWorker =
  | { type: 'read'; job: number; side: 'old' | 'new'; path: string; id: number }
  | { type: 'done'; job: number; result?: Awaited<ReturnType<typeof compare>>; error?: string };

const port = parentPort!;
const reads = new Map<number, (text: string | undefined) => void>();
let readId = 0;

port.on('message', async (m: ToWorker) => {
  if (m.type === 'read-result') {
    reads.get(m.id)?.(m.text);
    reads.delete(m.id);
    return;
  }
  const read = (side: 'old' | 'new') => (path: string) =>
    new Promise<string | undefined>((resolve) => {
      const id = ++readId;
      reads.set(id, resolve);
      port.postMessage({ type: 'read', job: m.job, side, path, id } satisfies FromWorker);
    });
  try {
    const result = await compare({ ...m.old, read: read('old') }, { ...m.new, read: read('new') }, m.options);
    port.postMessage({ type: 'done', job: m.job, result } satisfies FromWorker);
  } catch (e) {
    port.postMessage({ type: 'done', job: m.job, error: e instanceof Error ? e.message : String(e) } satisfies FromWorker);
  }
});
