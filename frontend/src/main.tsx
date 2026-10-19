import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        const checkForUpdate = () => {
          if (document.visibilityState === 'visible') void registration.update()
        }

        void registration.update()
        document.addEventListener('visibilitychange', checkForUpdate)
        window.addEventListener('focus', checkForUpdate)
      })
      .catch((error: unknown) => {
        console.error('Service worker registration failed:', error)
      })
  })

  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return
    refreshing = true
    window.location.reload()
  })
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
