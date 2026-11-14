import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  registerSW({ immediate: true });
}

// SEC-02: ErrorBoundary async handler fırlatmalarını yakalamaz. Yakalanmamış söz
// redlerini konsola ve kullanıcıya görünür bir olaya dönüştür.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const reason: any = event.reason;
    const message =
      typeof reason === 'string'
        ? reason
        : reason?.message || 'Beklenmeyen bir hata oluştu.';
    console.error('[CineTrack] Yakalanmamış hata:', reason);
    window.dispatchEvent(
      new CustomEvent('cinetrack:unhandled-error', { detail: { message } })
    );
  });
}

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

