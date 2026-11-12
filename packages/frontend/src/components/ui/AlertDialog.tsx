/**
 * AlertDialog - Classic Mac OS Alert Box
 *
 * A modal dialog styled like Mac OS 8 system alerts.
 * Supports error, warning, and info types with appropriate icons.
 * Features the classic beveled button style.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import styles from './AlertDialog.module.css';

export type AlertType = 'error' | 'warning' | 'info' | 'confirm';

interface AlertButton {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

interface AlertDialogProps {
  type: AlertType;
  title?: string;
  message: string;
  buttons?: AlertButton[];
  onClose?: () => void;
}

/**
 * Classic Mac OS Alert Dialog
 * - Error: Stop sign icon (⛔)
 * - Warning: Caution icon (⚠️)
 * - Info: Note icon (📝)
 * - Confirm: Question icon (?)
 */
export function AlertDialog({
  type,
  title,
  message,
  buttons,
  onClose,
}: AlertDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();

  // Remember what had focus before the dialog opened so we can restore it on
  // close (captured in a lazy initializer, before the primary button's
  // autoFocus runs, so it points at the real opener).
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
  );
  useEffect(() => () => { opener?.focus?.(); }, [opener]);

  // Default buttons based on type
  const defaultButtons = useMemo<AlertButton[]>(
    () =>
      buttons ?? (type === 'confirm'
        ? [
            { label: 'Cancel', onClick: () => onClose?.() },
            { label: 'OK', onClick: () => onClose?.(), primary: true },
          ]
        : [{ label: 'OK', onClick: () => onClose?.(), primary: true }]),
    [buttons, type, onClose]
  );

  // Escape closes; Tab is trapped inside the dialog.
  //
  // Enter is deliberately NOT handled here. A global Enter handler used to
  // click the primary button regardless of what was focused — so pressing
  // Enter while Cancel (or any other control) was focused still fired the
  // primary, often-destructive action. Native <button> activation runs the
  // FOCUSED button on Enter/Space instead, and the primary button's autoFocus
  // preserves "Enter confirms" when nothing else has been tabbed to.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose?.();
        return;
      }
      if (e.key === 'Tab') {
        const root = dialogRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const inside = root.contains(active);
        if (e.shiftKey && (active === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Prevent background interaction
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose?.();
      }
    },
    [onClose]
  );

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : messageId}
        aria-describedby={messageId}
        ref={dialogRef}
      >
        <div className={styles.content}>
          {/* Icon */}
          <div className={styles.iconContainer}>
            <AlertIcon type={type} />
          </div>

          {/* Message area */}
          <div className={styles.messageArea}>
            {title && <div className={styles.title} id={titleId}>{title}</div>}
            <div className={styles.message} id={messageId}>{message}</div>
          </div>
        </div>

        {/* Buttons */}
        <div className={styles.buttons}>
          {defaultButtons.map((button, index) => (
            <button
              key={index}
              className={`${styles.button} ${button.primary ? styles.primaryButton : ''}`}
              onClick={button.onClick}
              autoFocus={button.primary}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Classic Mac OS Alert Icons
 * Pixel-art style icons matching the System 7/8 aesthetic
 */
function AlertIcon({ type }: { type: AlertType }) {
  switch (type) {
    case 'error':
      return <StopIcon />;
    case 'warning':
      return <CautionIcon />;
    case 'info':
      return <NoteIcon />;
    case 'confirm':
      return <QuestionIcon />;
  }
}

/** Stop sign icon - for errors */
function StopIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" className={styles.icon}>
      {/* Octagon outline */}
      <polygon
        points="10,2 22,2 30,10 30,22 22,30 10,30 2,22 2,10"
        fill="var(--control-bg, #fff)"
        stroke="var(--control-border, #000)"
        strokeWidth="2"
      />
      {/* Hand symbol */}
      <rect x="8" y="14" width="16" height="4" fill="var(--danger, var(--text, #000))" />
    </svg>
  );
}

/** Caution/Warning triangle icon */
function CautionIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" className={styles.icon}>
      {/* Triangle */}
      <polygon
        points="16,2 30,28 2,28"
        fill="var(--control-bg, #fff)"
        stroke="var(--control-border, #000)"
        strokeWidth="2"
      />
      {/* Exclamation mark */}
      <rect x="14" y="10" width="4" height="10" fill="var(--danger, var(--text, #000))" />
      <rect x="14" y="22" width="4" height="4" fill="var(--danger, var(--text, #000))" />
    </svg>
  );
}

/** Note/Info icon - document with folded corner */
function NoteIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" className={styles.icon}>
      {/* Document body */}
      <path
        d="M4,2 L20,2 L28,10 L28,30 L4,30 Z"
        fill="var(--control-bg, #fff)"
        stroke="var(--control-border, #000)"
        strokeWidth="2"
      />
      {/* Folded corner */}
      <path d="M20,2 L20,10 L28,10" fill="none" stroke="var(--text, #000)" strokeWidth="2" />
      {/* Lines of text */}
      <line x1="8" y1="16" x2="24" y2="16" stroke="var(--text, #000)" strokeWidth="2" />
      <line x1="8" y1="22" x2="20" y2="22" stroke="var(--text, #000)" strokeWidth="2" />
    </svg>
  );
}

/** Question mark icon - for confirmations */
function QuestionIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" className={styles.icon}>
      {/* Circle */}
      <circle cx="16" cy="16" r="14" fill="var(--control-bg, #fff)" stroke="var(--control-border, #000)" strokeWidth="2" />
      {/* Question mark */}
      <path
        d="M12,10 Q12,6 16,6 Q20,6 20,10 Q20,14 16,16 L16,18"
        fill="none"
        stroke="var(--text, #000)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect x="14" y="22" width="4" height="4" fill="var(--text, #000)" />
    </svg>
  );
}
