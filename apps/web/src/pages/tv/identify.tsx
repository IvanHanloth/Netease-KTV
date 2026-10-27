import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from '../../components/icons'

const KEY = 'ktv.screenKey'

/** This browser's own 大屏 id, so the server gives it the same number (大屏 N) after a reload. */
export function screenKey(): string {
  try {
    let k = localStorage.getItem(KEY)
    if (!k) {
      // randomUUID needs a secure context; a 大屏 may be opened over plain http.
      k = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)
      localStorage.setItem(KEY, k)
    }
    return k
  } catch {
    return ''
  }
}

const SHOW_MS = 4000

/** 定位 from the 点歌台: this 大屏's number, big, for a few seconds. `at` changes on every request. */
export function IdentifyOverlay({ at, number, main }: { at: number; number: number | null; main: boolean }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!at) return
    setShown(true)
    const t = window.setTimeout(() => setShown(false), SHOW_MS)
    return () => window.clearTimeout(t)
  }, [at])
  return (
    <AnimatePresence>
      {shown && number !== null && (
        <motion.div
          key={at}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-ink-2/55 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <motion.div
            initial={{ scale: 0.86, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 22 }}
            className="glass relative flex flex-col items-center gap-[1.5vh] rounded-[48px] px-[6vw] py-[5vh] shadow-[0_40px_120px_rgba(0,0,0,0.6)]"
          >
            <span className="flex items-center gap-2 text-[clamp(18px,1.6vw,30px)] font-semibold tracking-[0.3em] text-fg-2">
              <Icon name="tv" size={28} />
              大屏
            </span>
            <span
              className="num bg-[linear-gradient(135deg,#FF4D7E_0%,#B57BFF_100%)] bg-clip-text text-[clamp(140px,22vh,280px)] leading-none font-black text-transparent"
              style={{ filter: 'drop-shadow(0 12px 40px rgba(255,77,126,0.45))' }}
            >
              {number}
            </span>
            <span
              className={
                main
                  ? 'rounded-full bg-accent px-5 py-1.5 text-[clamp(16px,1.3vw,24px)] font-bold text-accent-ink'
                  : 'rounded-full border border-white/15 bg-white/8 px-5 py-1.5 text-[clamp(16px,1.3vw,24px)] text-fg-2'
              }
            >
              {main ? '主屏' : '副屏'}
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
