import React from 'react';
import { resetDerivedCachesPreserveProfileAndStock } from '../services/idb-schema-version.ts';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  sectionName?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorName: string;
  errorMessage: string;
  errorStack: string;
  copied: boolean;
  isResettingCache: boolean;
  resetNotice: string;
}

/**
 * IMP-18: Sekme bazlı tanılayıcı Hata Kartı (Error Boundary).
 * Okunabilir hata metni, "Tekrar dene", "Hata metnini kopyala" ve
 * profil/stok verilerine dokunmadan türetilmiş önbellekleri temizleyen "Önbellekleri sıfırla ve dene" aksiyonları sunar.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorName: '',
      errorMessage: '',
      errorStack: '',
      copied: false,
      isResettingCache: false,
      resetNotice: '',
    };
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    if (error instanceof Error) {
      const stackLines = typeof error.stack === 'string'
        ? error.stack.split('\n').slice(0, 5).join('\n')
        : '';
      return {
        hasError: true,
        errorName: error.name || 'Error',
        errorMessage: error.message || 'Beklenmeyen bir çalışma zamanı hatası oluştu.',
        errorStack: stackLines,
        copied: false,
        resetNotice: '',
      };
    }

    return {
      hasError: true,
      errorName: 'RuntimeError',
      errorMessage: typeof error === 'string' && error.trim()
        ? error
        : 'Beklenmeyen bir arayüz hatası oluştu.',
      errorStack: '',
      copied: false,
      resetNotice: '',
    };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error(
      `[Cinethos ErrorBoundary${this.props.sectionName ? `: ${this.props.sectionName}` : ''}]`,
      error,
      info
    );
  }

  componentWillUnmount(): void {
    if (this.copyTimer) {
      clearTimeout(this.copyTimer);
      this.copyTimer = null;
    }
  }

  buildDiagnosticPayload(): string {
    const lines = [
      `Bölüm: ${this.props.sectionName || 'Genel Görünüm'}`,
      `Hata: ${this.state.errorName ? `${this.state.errorName}: ` : ''}${this.state.errorMessage}`,
      `Zaman: ${new Date().toISOString()}`,
    ];
    if (this.state.errorStack) {
      lines.push(`İz:\n${this.state.errorStack}`);
    }
    return lines.join('\n');
  }

  handleRetry = (): void => {
    this.setState({
      hasError: false,
      errorName: '',
      errorMessage: '',
      errorStack: '',
      copied: false,
      isResettingCache: false,
      resetNotice: '',
    });
    this.props.onReset?.();
  };

  handleCopyError = async (): Promise<void> => {
    const text = this.buildDiagnosticPayload();
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.className = 'sr-only';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      this.setState({ copied: true });
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.setState({ copied: false });
      }, 2500);
    } catch {
      this.setState({ resetNotice: 'Pano erişimi tarayıcı tarafından engellendi.' });
    }
  };

  handleResetCachesAndRetry = async (): Promise<void> => {
    this.setState({ isResettingCache: true, resetNotice: '' });
    try {
      await resetDerivedCachesPreserveProfileAndStock();
      this.handleRetry();
    } catch {
      this.setState({
        isResettingCache: false,
        resetNotice: 'Önbellek sıfırlanırken bir sorun oluştu; lütfen sayfayı yenileyin.',
      });
    }
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      const readableHeadline = this.state.errorName
        ? `${this.state.errorName}: ${this.state.errorMessage}`
        : this.state.errorMessage;

      return (
        <div className="section-error-boundary error-diagnostic-card" role="alert">
          <div className="error-diagnostic-header">
            <span className="error-icon" aria-hidden="true">⚠️</span>
            <div>
              <strong className="error-diagnostic-title">
                {this.props.sectionName
                  ? `${this.props.sectionName} yüklenirken bir hata oluştu`
                  : 'Bu bölümde beklenmeyen bir sorun oluştu'}
              </strong>
              <p className="error-section-sub">
                Diğer sekmeler ve kayıtlı izleme listeniz güvenle çalışmaya devam ediyor.
              </p>
            </div>
          </div>

          <div className="error-diagnostic-message">
            <code>{readableHeadline}</code>
          </div>

          {this.state.errorStack && (
            <details className="error-diagnostic-details">
              <summary>Teknik hata izini göster</summary>
              <pre className="error-diagnostic-stack">{this.state.errorStack}</pre>
            </details>
          )}

          {this.state.resetNotice && (
            <p className="error-diagnostic-notice" role="status">
              {this.state.resetNotice}
            </p>
          )}

          <div className="message-actions error-diagnostic-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={this.handleRetry}
              disabled={this.state.isResettingCache}
            >
              Tekrar dene
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void this.handleResetCachesAndRetry()}
              disabled={this.state.isResettingCache}
            >
              {this.state.isResettingCache
                ? 'Önbellekler temizleniyor…'
                : 'Önbellekleri sıfırla ve dene'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void this.handleCopyError()}
            >
              {this.state.copied ? '✓ Hata metni kopyalandı' : 'Hata metnini kopyala'}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
