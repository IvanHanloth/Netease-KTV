import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

const same = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i])

/** Keep a local order but follow additions / removals coming from the server. */
function reconcile(local: string[], server: string[]): string[] {
  const set = new Set(server)
  const kept = local.filter((k) => set.has(k))
  const keptSet = new Set(kept)
  return [...kept, ...server.filter((k) => !keptSet.has(k))]
}

/**
 * Pointer-based (mouse + touch) drag-to-reorder with keyboard support.
 * The list renders in `ordered`; the drag handle gets `handleProps(key)`;
 * each row gets `rowRef(key)`. `commit` receives the new key order.
 */
export function useDragReorder<T>(
  items: T[],
  keyOf: (item: T) => string,
  commit: (keys: string[]) => Promise<unknown>,
  onError?: (err: unknown) => void,
) {
  const serverKeys = items.map(keyOf)
  const [local, setLocal] = useState<string[] | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLElement>())
  const pending = useRef(false)

  const order = local ? reconcile(local, serverKeys) : serverKeys
  const byKey = new Map(items.map((i) => [keyOf(i), i] as const))
  const ordered = order.map((k) => byKey.get(k)).filter((x): x is T => x !== undefined)

  // Drop the optimistic order once the server's broadcast matches it.
  const serverSig = serverKeys.join('|')
  useEffect(() => {
    if (local && !dragKey && pending.current && same(reconcile(local, serverKeys), serverKeys)) {
      pending.current = false
      setLocal(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSig, local, dragKey])

  const finish = useCallback(
    async (keys: string[], start: string[]) => {
      if (same(keys, start)) {
        setLocal(null)
        return
      }
      setLocal(keys)
      pending.current = true
      try {
        await commit(keys)
        // Safety net in case the broadcast never matches (e.g. queue changed meanwhile).
        setTimeout(() => {
          if (pending.current) {
            pending.current = false
            setLocal(null)
          }
        }, 3000)
      } catch (err) {
        pending.current = false
        setLocal(null)
        onError?.(err)
      }
    },
    [commit, onError],
  )

  const rowRef = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) rows.current.set(key, el)
      else rows.current.delete(key)
    },
    [],
  )

  const handleProps = (key: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      const start = order.slice()
      let cur = start
      setDragKey(key)
      setLocal(start)
      const move = (ev: PointerEvent) => {
        const others = cur.filter((k) => k !== key)
        let idx = 0
        for (const k of others) {
          const r = rows.current.get(k)?.getBoundingClientRect()
          if (r && ev.clientY > r.top + r.height / 2) idx++
        }
        const next = [...others]
        next.splice(idx, 0, key)
        if (!same(next, cur)) {
          cur = next
          setLocal(next)
        }
      }
      const up = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
        setDragKey(null)
        void finish(cur, start)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const idx = order.indexOf(key)
      const to = e.key === 'ArrowUp' ? idx - 1 : idx + 1
      if (idx < 0 || to < 0 || to >= order.length) return
      const next = order.slice()
      next.splice(idx, 1)
      next.splice(to, 0, key)
      void finish(next, order)
      // Keep focus on the moved handle after re-render.
      const target = e.currentTarget
      requestAnimationFrame(() => target.focus())
    },
    style: { touchAction: 'none' as const },
    'aria-roledescription': '拖动排序',
  })

  return { ordered, dragKey, rowRef, handleProps }
}
