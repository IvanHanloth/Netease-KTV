import { create } from 'zustand'

const KEY = 'ktv.nickname'
const ASKED_KEY = 'ktv.nickname.asked'
export const NICKNAME_MAX = 12

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* storage unavailable */
  }
}

interface NicknameStore {
  /** The singer's nickname, sent as `addedBy` with every 点歌 request ('' = none). */
  nickname: string
  /** Whether the phone already prompted for a nickname once. */
  asked: boolean
  setNickname: (name: string) => void
  markAsked: () => void
}

export const useNickname = create<NicknameStore>((set) => ({
  nickname: read(KEY),
  asked: read(ASKED_KEY) === '1',
  setNickname: (name) => {
    const clean = name.trim().slice(0, NICKNAME_MAX)
    write(KEY, clean)
    write(ASKED_KEY, '1')
    set({ nickname: clean, asked: true })
  },
  markAsked: () => {
    write(ASKED_KEY, '1')
    set({ asked: true })
  },
}))

/** Current nickname for API calls (outside React). */
export const currentNickname = () => useNickname.getState().nickname || undefined
