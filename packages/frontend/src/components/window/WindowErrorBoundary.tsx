import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError } from './chunkError';
import styles from './WindowErrorBoundary.module.css';

interface WindowErrorBoundaryProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

interface WindowErrorBoundaryState {
  error: unknown;
  hasError: boolean;
  /** Bumped by "Reload" to remount the viewer from scratch. */
  attempt: number;
  /** It crashed again right after a remount: only a page reload can help
   *  (e.g. React.lazy caches any failed import, not just missing chunks). */
  stuck: boolean;
}

/** A crash this soon after an in-place reload counts as the same failure. */
const STUCK_WINDOW_MS = 3000;

/**
 * Per-window error boundary: a viewer that throws (or whose lazy chunk is
 * gone after a deploy) breaks only its own window, which can then be closed
 * or reloaded. The rest of the desktop keeps running.
 */
export class WindowErrorBoundary extends Component<WindowErrorBoundaryProps, WindowErrorBoundaryState> {
  state: WindowErrorBoundaryState = { error: null, hasError: false, attempt: 0, stuck: false };
  private lastRetryAt = 0;

  static getDerivedStateFromError(error: unknown): Partial<WindowErrorBoundaryState> {
    return { error, hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`Window "${this.props.title}" crashed:`, error, info.componentStack);
    if (this.lastRetryAt && Date.now() - this.lastRetryAt < STUCK_WINDOW_MS) this.setState({ stuck: true });
  }

  private needsPageReload(): boolean {
    return this.state.stuck || isChunkLoadError(this.state.error);
  }

  handleReload = (): void => {
    // React.lazy caches a failed import: only a page reload fetches the
    // new build's chunks.
    if (this.needsPageReload()) {
      window.location.reload();
      return;
    }
    this.lastRetryAt = Date.now();
    this.setState((state) => ({ error: null, hasError: false, attempt: state.attempt + 1 }));
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }

    const chunkError = isChunkLoadError(this.state.error);
    const pageReload = this.needsPageReload();
    const detail = this.state.error instanceof Error ? this.state.error.message : String(this.state.error ?? '');

    return (
      <div className={styles.crash} role="alert">
        <div className={styles.body}>
          <span className={styles.icon} aria-hidden="true">!</span>
          <div className={styles.message}>
            <p className={styles.mainText}>
              {chunkError
                ? 'EternalOS was updated while this window was opening. Reload to get the new version.'
                : `“${this.props.title}” ran into a problem and stopped.`}
            </p>
            {!chunkError && detail && <p className={styles.detail}>{detail}</p>}
          </div>
        </div>
        <div className={styles.buttons}>
          <button type="button" className={styles.button} onClick={this.props.onClose}>
            Close window
          </button>
          <button type="button" className={`${styles.button} ${styles.primary}`} onClick={this.handleReload}>
            {pageReload ? 'Reload EternalOS' : 'Reload'}
          </button>
        </div>
      </div>
    );
  }
}
