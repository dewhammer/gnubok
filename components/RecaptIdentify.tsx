'use client'

import { useEffect } from 'react'

declare global {
  interface Window {
    Recapt?: {
      session: {
        setIdentity: (identity: {
          uid: string
          email?: string
          nickname?: string
          fullName?: string
        }) => void
      }
    }
  }
}

export function RecaptIdentify({
  userId,
  email,
  displayName,
}: {
  userId: string
  email?: string
  displayName?: string
}) {
  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof window.Recapt?.session?.setIdentity === 'function') {
        window.Recapt.session.setIdentity({
          uid: userId,
          email: email,
          fullName: displayName,
        })
        clearInterval(interval)
      }
    }, 500)

    return () => clearInterval(interval)
  }, [userId, email, displayName])

  return null
}
