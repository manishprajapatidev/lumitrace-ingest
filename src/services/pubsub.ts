/**
 * In-process pub/sub for live tail. Single-node only.
 * Swap for Redis pub/sub when you scale horizontally — keep this interface.
 */
import type { LogRow } from '../types/domain.js';

type Listener = (log: LogRow) => void;

class PubSub {
  private readonly subs = new Map<string, Set<Listener>>();

  subscribe(sourceId: string, listener: Listener): () => void {
    let set = this.subs.get(sourceId);
    if (!set) {
      set = new Set();
      this.subs.set(sourceId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.subs.delete(sourceId);
    };
  }

  publish(sourceId: string, log: LogRow): void {
    const set = this.subs.get(sourceId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(log);
      } catch {
        /* never let one bad subscriber break the loop */
      }
    }
  }

  subscriberCount(sourceId: string): number {
    return this.subs.get(sourceId)?.size ?? 0;
  }
}

export const pubsub = new PubSub();
