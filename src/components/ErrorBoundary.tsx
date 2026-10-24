import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  sectionName?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: '',
    };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : 'Beklenmeyen bir arayüz hatası oluştu.',
    };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error(`[CineTrack ErrorBoundary${this.props.sectionName ? `: ${this.props.sectionName}` : ''}]`, error, info);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, errorMessage: '' });
    this.props.onReset?.();
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="section-error-boundary" role="alert">
          <span className="error-icon" aria-hidden="true">⚠️</span>
          <strong>Bu bölümde bir sorun oluştu.</strong>
          {this.props.sectionName && (
            <p className="error-section-sub">({this.props.sectionName})</p>
          )}
          <div className="message-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={this.handleRetry}>
              Yenile
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
