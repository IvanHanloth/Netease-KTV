import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import clsx from 'clsx'

export function QrCode({
  value,
  size = 132,
  label = '二维码',
  className,
}: {
  value: string
  size?: number
  label?: string
  className?: string
}) {
  const [src, setSrc] = useState<string>('')
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(value, {
      margin: 1,
      width: size * 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0A0A0F', light: '#FFFFFF' },
    })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(''))
    return () => {
      alive = false
    }
  }, [value, size])
  return (
    <div
      className={clsx('shrink-0 overflow-hidden rounded-[14px] bg-white p-2', className)}
      style={{ width: size, height: size }}
    >
      {src ? (
        <img src={src} alt={label} className="block h-full w-full" style={{ imageRendering: 'pixelated' }} />
      ) : (
        <div role="img" aria-label={label} className="h-full w-full" />
      )}
    </div>
  )
}
