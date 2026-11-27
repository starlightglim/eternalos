import { useDesktopStore } from '../../stores/desktopStore';
import styles from './UploadProgress.module.css';

/**
 * UploadProgress - Classic Mac OS style upload progress indicator
 * Displays in a small retro window at the bottom-right corner
 */
export function UploadProgress() {
  const uploads = useDesktopStore((s) => s.uploads);
  const clearUpload = useDesktopStore((s) => s.clearUpload);

  if (uploads.length === 0) {
    return null;
  }

  return (
    <div className={styles.container}>
      {uploads.map((upload) => (
        <div
          key={upload.id}
          className={`${styles.uploadWindow} ${upload.status === 'error' ? styles.error : ''}`}
        >
          {/* Title bar */}
          <div className={styles.titleBar}>
            <span className={styles.title}>
              {upload.status === 'uploading' && 'Uploading...'}
              {upload.status === 'complete' && 'Complete'}
              {upload.status === 'error' && 'Upload Failed'}
            </span>
            <button
              className={styles.closeButton}
              onClick={() => clearUpload(upload.id)}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {/* Content */}
          <div className={styles.content}>
            {/* File icon */}
            <div className={styles.fileIcon}>
              <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
                <rect x="4" y="2" width="20" height="26" fill="#FFFFFF" stroke="#000000" strokeWidth="2" />
                <rect x="8" y="8" width="12" height="2" fill="#808080" />
                <rect x="8" y="12" width="12" height="2" fill="#808080" />
                <rect x="8" y="16" width="8" height="2" fill="#808080" />
              </svg>
            </div>

            {/* File info */}
            <div className={styles.fileInfo}>
              <span className={styles.filename}>{upload.filename}</span>

              {/* Progress bar */}
              {upload.status === 'uploading' && (
                <div className={styles.progressContainer}>
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressBar}
                      style={{ width: `${upload.progress}%` }}
                    />
                  </div>
                  <span className={styles.progressText}>{Math.round(upload.progress)}%</span>
                </div>
              )}

              {/* Status messages */}
              {upload.status === 'complete' && (
                <span className={styles.statusComplete}>✓ Upload complete</span>
              )}
              {upload.status === 'error' && (
                <span className={styles.statusError}>{upload.error || 'Upload failed'}</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
