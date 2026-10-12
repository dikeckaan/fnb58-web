import '@fontsource-variable/red-hat-display/wght.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { wireEngine } from './state/connection';

wireEngine();
// Canvas text does not wait for web fonts, so ask for the readout face up front.
void document.fonts?.load('11px "Bench Mono"', '0.:');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support. Skipped in development so the dev server always serves fresh code.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
