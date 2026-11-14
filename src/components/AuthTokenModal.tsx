import React, { useEffect, useRef, useState } from 'react';
import { setClientAuthToken } from '../services/api-client.ts';

interface AuthTokenModalProps {
  open: boolean;
  status: number;
  onSubmit: (token: string) => void;
  onClose: () => void;
}

/**
 * SEC-03: Sunucu loopback dışına bağlandığında (LAN modu) `CINETRACK_TOKEN` ister.
 * İstemci anahtarı yalnızca sessionStorage'da tutar; localStorage'a yazılmaz.
 */
export const AuthTokenModal: React.FC<AuthTokenModalProps> = ({ open, status, onSubmit, onClose }) => {
  const [token, setToken] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const isForbidden = status === 503;

  return (
    <div className="auth-token-overlay" role="dialog" aria-modal="true" aria-labelledby="authTokenTitle">
      <form
        className="auth-token-card"
        onSubmit={(event) => {
          event.preventDefault();
          const clean = token.trim();
          if (!clean) return;
          setClientAuthToken(clean);
          onSubmit(clean);
        }}
      >
        <h2 id="authTokenTitle">Sunucu erişim anahtarı gerekli</h2>
        <p>
          {isForbidden
            ? 'Sunucu yerel ağa açık ve CINETRACK_TOKEN tanımlı değil. Sunucuda anahtarı tanımlayıp aşağıya girin.'
            : 'Sunucu bu isteği yetkisiz buldu. CINETRACK_TOKEN değerini girin; anahtar yalnızca bu sekme oturumu için saklanır.'}
        </p>
        <label htmlFor="authTokenInput">Erişim anahtarı</label>
        <input
          id="authTokenInput"
          ref={inputRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <div className="auth-token-actions">
          <button type="button" className="btn" onClick={onClose}>
            Şimdi değil
          </button>
          <button type="submit" className="btn btn-primary" disabled={!token.trim()}>
            Kaydet ve yeniden dene
          </button>
        </div>
      </form>
    </div>
  );
};
