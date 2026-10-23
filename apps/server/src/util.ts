/** Small helpers shared across server modules. */

/** A size-capped map whose entries expire `ttlMs` after they were set. */
export class TtlCache<K, V> {
  private map = new Map<K, { value: V; at: number }>()

  constructor(
    private ttlMs: number,
    private max = 500,
  ) {}

  get(key: K): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (Date.now() - e.at > this.ttlMs) {
      this.map.delete(key)
      return undefined
    }
    return e.value
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, { value, at: Date.now() })
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K)
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}

/**
 * Deduplicates concurrent work by key: while a job for `key` runs, later callers get the same
 * promise. The entry goes away when the job settles.
 */
export function singleFlight<K, T>(): (key: K, run: () => Promise<T>) => Promise<T> {
  const running = new Map<K, Promise<T>>()
  return (key, run) => {
    const existing = running.get(key)
    if (existing) return existing
    const job = run().finally(() => running.delete(key))
    running.set(key, job)
    return job
  }
}
