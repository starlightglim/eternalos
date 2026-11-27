import { Component, Fragment, type ReactNode, type ErrorInfo } from 'react';
import { isChunkLoadError } from '../window/chunkError';
import styles from './ErrorBoundary.module.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback component. If not provided, uses the default Mac OS error dialog. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** Bumped by "Try Again" so the tree remounts with fresh state. */
  resetCount: number;
  /** The error came back right after "Try Again": retrying can't help. */
  repeated: boolean;
}

/** A crash this soon after "Try Again" counts as the same failure again. */
const REPEAT_WINDOW_MS = 5000;

/**
 * ErrorBoundary - Catches React rendering errors and shows a Mac OS-styled error dialog
 * instead of crashing the entire app.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private lastResetAt = 0;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, resetCount: 0, repeated: false };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    if (this.lastResetAt && Date.now() - this.lastResetAt < REPEAT_WINDOW_MS) {
      this.setState({ repeated: true });
    }
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleDismiss = (): void => {
    // Remount the children (fresh component state) instead of re-rendering
    // the same failing tree; if it fails again right away, only Restart is
    // offered.
    this.lastResetAt = Date.now();
    this.setState((state) => ({ hasError: false, error: null, resetCount: state.resetCount + 1 }));
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // A missing chunk (new deploy) or a crash that survived a retry can
      // only be fixed by reloading the page.
      const canRetry = !this.state.repeated && !isChunkLoadError(this.state.error);

      return (
        <div className={styles.overlay}>
          <div className={styles.dialog} role="alertdialog" aria-labelledby="eos-system-error-title">
            <div className={styles.titleBar}>
              <span id="eos-system-error-title" className={styles.titleText}>System Error</span>
            </div>
            <div className={styles.content}>
              <div className={styles.iconRow}>
                <span className={styles.errorIcon}>⚠️</span>
                <div className={styles.message}>
                  <p className={styles.mainText}>
                    {canRetry
                      ? 'Something went wrong and this part of the application needs to restart.'
                      : 'Something went wrong and EternalOS needs to restart.'}
                  </p>
                  {this.state.error && (
                    <p className={styles.errorDetail}>
                      {this.state.error.message}
                    </p>
                  )}
                </div>
              </div>
              <div className={styles.buttons}>
                {canRetry && (
                  <button type="button" className={styles.button} onClick={this.handleDismiss}>
                    Try Again
                  </button>
                )}
                <button type="button" className={`${styles.button} ${styles.primaryButton}`} onClick={this.handleReload}>
                  Restart
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return <Fragment key={this.state.resetCount}>{this.props.children}</Fragment>;
  }
}
