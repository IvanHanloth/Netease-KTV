import { createContext, useContext } from 'react'

/** Lets song lists open album / artist pages on the desk (absent elsewhere: names stay plain text). */
export interface DeskNav {
  openAlbum: (id: number, name: string) => void
  openArtist: (id: number, name: string) => void
}

export const DeskNavContext = createContext<DeskNav | null>(null)

export const useDeskNav = () => useContext(DeskNavContext)
