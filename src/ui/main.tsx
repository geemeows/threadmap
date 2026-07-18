import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// PROTOTYPE (ticket #58): `?variant=` swaps in the visual-direction mock screen. Throwaway.
import { VisualDirectionPrototype, prototypeEnabled } from './prototype/VisualDirectionPrototype'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{prototypeEnabled ? <VisualDirectionPrototype /> : <App />}</StrictMode>,
)
