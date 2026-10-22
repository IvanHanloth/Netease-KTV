import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import { useToasts } from '../lib/hooks'
import { Icon } from './icons'

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-8"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className={clsx(
              'glass flex items-center gap-2 rounded-2xl px-4 py-3 text-sm shadow-[0_12px_30px_rgba(0,0,0,0.45)]',
              t.tone === 'error' ? 'text-accent-soft' : 'text-fg',
            )}
          >
            <Icon name={t.tone === 'error' ? 'alert' : 'check'} size={16} strokeWidth={2.1} />
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
