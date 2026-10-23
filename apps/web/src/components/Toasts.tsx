import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import { useToasts } from '../lib/hooks'
import { Icon } from './icons'

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(80px+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 sm:bottom-8"
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
              'glass flex max-w-full items-center gap-2 rounded-2xl py-3 pl-4 text-sm shadow-[0_12px_30px_rgba(0,0,0,0.45)]',
              t.action ? 'pointer-events-auto pr-2' : 'pr-4',
              t.tone === 'error' ? 'text-accent-soft' : 'text-fg',
            )}
          >
            <Icon name={t.tone === 'error' ? 'alert' : 'check'} size={16} strokeWidth={2.1} className="shrink-0" />
            <span className="min-w-0">{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  dismiss(t.id)
                  t.action!.run()
                }}
                className="ml-1 h-8 shrink-0 rounded-xl bg-white/10 px-3 text-[13px] font-semibold whitespace-nowrap text-fg hover:bg-white/16"
              >
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
