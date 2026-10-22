import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { QrStatus } from '@shared/types'
import { api } from '../lib/api'
import { errorText, toast } from '../lib/hooks'
import { QrCode } from './QrCode'
import { Dialog, Spinner } from './ui'
import { Icon } from './icons'

export function LoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [qr, setQr] = useState<{ key: string; qrUrl: string } | null>(null)
  const [status, setStatus] = useState<QrStatus>('waiting')
  const [error, setError] = useState('')
  const [manual, setManual] = useState(false)
  const [cookie, setCookie] = useState('')
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0)

  // create a QR key whenever the dialog opens / refreshes
  useEffect(() => {
    if (!open || manual) return
    let alive = true
    setQr(null)
    setError('')
    setStatus('waiting')
    api
      .createQr()
      .then((r) => alive && setQr(r))
      .catch((e) => alive && setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [open, manual, nonce])

  // poll status
  useEffect(() => {
    if (!open || !qr || status === 'expired' || status === 'ok') return
    const t = setInterval(async () => {
      try {
        const r = await api.checkQr(qr.key)
        setStatus(r.status)
        if (r.status === 'ok') {
          await qc.invalidateQueries()
          toast(`已登录：${r.account?.nickname ?? '网易云账号'}`)
          onClose()
        }
      } catch {
        /* transient */
      }
    }, 2000)
    return () => clearInterval(t)
  }, [open, qr, status, qc, onClose])

  async function submitCookie() {
    setBusy(true)
    try {
      const acc = await api.loginCookie(cookie.trim())
      await qc.invalidateQueries()
      toast(`已登录：${acc.nickname ?? '网易云账号'}`)
      onClose()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="登录网易云音乐" width={420}>
      {!manual ? (
        <div className="flex flex-col items-center gap-4 pt-2">
          <div className="relative">
            {qr ? (
              <QrCode value={qr.qrUrl} size={208} label="网易云音乐登录二维码" />
            ) : (
              <div className="flex h-[208px] w-[208px] items-center justify-center rounded-[14px] bg-white/5 text-muted">
                {error ? <Icon name="alert" size={28} /> : <Spinner size={28} />}
              </div>
            )}
            {(status === 'scanned' || status === 'expired') && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-[14px] bg-ink/85 backdrop-blur-sm">
                {status === 'scanned' ? (
                  <>
                    <Icon name="check" size={36} className="text-ok" />
                    <span className="text-[15px] font-semibold">已扫码，请在手机上确认</span>
                  </>
                ) : (
                  <>
                    <span className="text-[15px] font-semibold">二维码已过期</span>
                    <button
                      type="button"
                      onClick={() => setNonce((n) => n + 1)}
                      className="h-10 rounded-xl bg-accent px-4 text-sm font-bold text-accent-ink"
                    >
                      刷新二维码
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <p className="m-0 whitespace-pre-line text-center text-sm leading-6 text-muted">
            {error || '打开网易云音乐 App，扫码登录。\n登录后只会使用该账号有权播放的歌曲。'}
          </p>
          <button type="button" onClick={() => setManual(true)} className="h-10 text-sm text-accent-soft hover:text-[#FFC2D1]">
            扫码有问题？手动粘贴 Cookie
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 pt-2">
          <label className="flex flex-col gap-2">
            <span className="text-sm text-fg-2">Cookie（至少包含 MUSIC_U）</span>
            <textarea
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              rows={4}
              placeholder="MUSIC_U=xxxxxxxx; __csrf=xxxx"
              className="resize-none rounded-2xl border border-white/10 bg-white/5 p-3 font-mono text-[13px] text-fg outline-none placeholder:text-faint focus:border-white/25"
            />
          </label>
          <p className="m-0 text-xs leading-5 text-muted">
            Cookie 只保存在这台 KTV 主机上，用于以你的账号身份调用网易云接口。不要把它分享给别人。
          </p>
          <div className="flex justify-between gap-3">
            <button type="button" onClick={() => setManual(false)} className="h-11 px-2 text-sm text-muted hover:text-fg">
              返回扫码登录
            </button>
            <button
              type="button"
              disabled={!cookie.trim() || busy}
              onClick={submitCookie}
              className="h-11 rounded-xl bg-accent px-5 text-sm font-bold text-accent-ink disabled:opacity-50"
            >
              {busy ? '登录中…' : '登录'}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
