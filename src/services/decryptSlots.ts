// Shared cap for sealed decrypts. A bubble that leaves the screen while
// queued never starts. One that already started keeps its slot until the
// bytes settle, so a third decrypt cannot begin early.

export type DecryptJob<T> = {
  promise: Promise<T>;
  /** Drop a job that has not started. Returns false once it holds a slot. */
  cancel: () => boolean;
};

type Waiter = {
  cancelled: boolean;
  started: boolean;
  begin: () => void;
};

export function createDecryptGate(limit: number) {
  let active = 0;
  const queue: Waiter[] = [];

  function pump(): void {
    while (active < limit && queue.length > 0) {
      const waiter = queue.shift();
      if (!waiter || waiter.cancelled) continue;
      active += 1;
      waiter.started = true;
      waiter.begin();
    }
  }

  function run<T>(work: () => Promise<T>): DecryptJob<T> {
    let resolveJob: (value: T) => void = () => {};
    let rejectJob: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const waiter: Waiter = {
      cancelled: false,
      started: false,
      begin() {
        let pending: Promise<T>;
        try {
          pending = work();
        } catch (err) {
          pending = Promise.reject(err);
        }
        pending.then(
          (value) => {
            active -= 1;
            pump();
            resolveJob(value);
          },
          (err: unknown) => {
            active -= 1;
            pump();
            rejectJob(err);
          }
        );
      },
    };
    queue.push(waiter);
    pump();
    return {
      promise,
      cancel() {
        if (waiter.started) return false;
        if (waiter.cancelled) return true;
        waiter.cancelled = true;
        const at = queue.indexOf(waiter);
        if (at >= 0) queue.splice(at, 1);
        rejectJob(new Error('cancelled'));
        return true;
      },
    };
  }

  return {
    run,
    inFlight(): number {
      return active;
    },
    queued(): number {
      return queue.length;
    },
  };
}

export const decryptGate = createDecryptGate(2);

// FlatList only reports the viewport. The visible index span is about one
// screen of rows, so the same span above and below is about one more screen.
export function nearKeysForView(
  rows: ReadonlyArray<{ key: string }>,
  viewable: ReadonlyArray<{ index: number | null; isViewable?: boolean }>
): string[] {
  const indexes: number[] = [];
  for (const token of viewable) {
    if (token.isViewable === false) continue;
    if (token.index == null || token.index < 0 || token.index >= rows.length) continue;
    indexes.push(token.index);
  }
  if (indexes.length === 0) return [];
  let min = indexes[0];
  let max = indexes[0];
  for (const index of indexes) {
    if (index < min) min = index;
    if (index > max) max = index;
  }
  const span = max - min + 1;
  const from = Math.max(0, min - span);
  const to = Math.min(rows.length - 1, max + span);
  const keys: string[] = [];
  for (let i = from; i <= to; i += 1) keys.push(rows[i].key);
  return keys;
}
