import type { ReactNode } from 'react'
import clsx from 'clsx'

/** Building blocks shared by the 后台管理 sections. */

export function Card({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-3xl border border-white/7 bg-white/[0.025] p-5 sm:p-6', className)}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="m-0 text-xs font-medium tracking-[0.12em] text-subtle">{title}</h2>}
          {action}
        </div>
      )}
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  )
}

/** Title + help on the left, control on the right (stacks on phones when `stack`). */
export function Row({ title, help, children, stack }: { title: string; help?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={clsx('flex gap-3', stack ? 'flex-col' : 'items-center justify-between gap-5')}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[15px] font-semibold">{title}</span>
        {help && <span className="text-xs leading-5 text-muted">{help}</span>}
      </div>
      {children}
    </div>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid gap-1 rounded-xl bg-white/5 p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={clsx(
              'h-9 min-w-0 truncate rounded-lg px-1.5 text-sm whitespace-nowrap transition-colors',
              on ? 'bg-fg font-semibold text-ink' : 'text-fg-2 hover:bg-white/8',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export const inputCls =
  'h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-fg outline-none placeholder:text-faint focus:border-white/25'


export const MODELS: { value: string; label: string; note: string }[] = [
  { value: '', label: '自动', note: '有 NVIDIA 显卡用 RoFormer，否则用 MDX-Net' },
  {
    value: 'mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt',
    label: 'Mel-Band RoFormer Karaoke',
    note: '效果最好，需要显卡，约 900 MB',
  },
  { value: 'UVR_MDXNET_KARA_2.onnx', label: 'UVR MDX-Net Karaoke 2', note: '轻量，CPU 也能跑，约 50 MB' },
]


export function ChoiceCard({ on, onClick, title, note }: { on: boolean; onClick: () => void; title: string; note: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={clsx(
        'flex items-center gap-3.5 rounded-2xl border px-4 py-3 text-left transition-colors',
        on ? 'border-[rgba(139,123,255,0.55)] bg-[rgba(109,75,255,0.12)]' : 'border-white/8 bg-white/[0.02] hover:bg-white/5',
      )}
    >
      <span
        className={clsx(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
          on ? 'border-[#8B7BFF]' : 'border-white/25',
        )}
      >
        {on && <span className="h-2.5 w-2.5 rounded-full bg-[#8B7BFF]" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px] font-semibold">{title}</span>
        <span className="text-xs leading-5 text-muted">{note}</span>
      </span>
    </button>
  )
}
