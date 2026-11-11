import { Component, type ReactNode, type ErrorInfo } from 'react';
import styles from './ErrorBoundary.module.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback component. If not provided, uses the default Mac OS error dialog. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * ErrorBoundary - Catches React rendering errors and shows a Mac OS-styled error dialog
 * instead of crashing the entire app.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleDismiss = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className={styles.overlay}>
          <div className={styles.dialog}>
            <div className={styles.titleBar}>
              <span className={styles.titleText}>System Error</span>
            </div>
            <div className={styles.content}>
              <div className={styles.iconRow}>
                <span className={styles.errorIcon}>⚠️</span>
                <div className={styles.message}>
                  <p className={styles.mainText}>
                    Something went wrong and this part of the application needs to restart.
                  </p>
                  {this.state.error && (
                    <p className={styles.errorDetail}>
                      {this.state.error.message}
                    </p>
                  )}
                </div>
              </div>
              <div className={styles.buttons}>
                <button type="button" className={styles.button} onClick={this.handleDismiss}>
                  Try Again
                </button>
                <button type="button" className={`${styles.button} ${styles.primaryButton}`} onClick={this.handleReload}>
                  Restart
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
