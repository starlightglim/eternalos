/**
 * RecoveryCodesDialog — one-time reveal of the 10 recovery codes generated
 * at signup. User must acknowledge saving them before continuing to the
 * desktop. The server will not show these again.
 */

import { useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import styles from './RecoveryCodesDialog.module.css';

interface RecoveryCodesDialogProps {
  codes: string[];
  username: string;
  onContinue: () => void;
}

export function RecoveryCodesDialog({ codes, username, onContinue }: RecoveryCodesDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Tab stays inside and focus moves in on open. No onEscape: the codes are
  // shown once and must be acknowledged, so Escape must not dismiss them
  // (and the overlay has no click-to-close either).
  useFocusTrap(dialogRef);

  const allCodesText = [
    `EternalOS recovery codes for @${username}`,
    `Generated ${new Date().toISOString()}`,
    '',
    'Use any of these codes ONCE to recover access if you lose your password.',
    'Store them somewhere safe (password manager, paper in a drawer).',
    '',
    ...codes,
    '',
    'You can regenerate codes anytime from Preferences → Account.',
  ].join('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback — show codes for manual copy
    }
  };

  const handleDownload = () => {
    const blob = new Blob([allCodesText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eternalos-recovery-codes-${username}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className={styles.overlay}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-labelledby="recovery-codes-title"
        aria-describedby="recovery-codes-subtitle"
        aria-modal="true"
      >
        <h2 id="recovery-codes-title" className={styles.title}>Save your recovery codes</h2>
        <p id="recovery-codes-subtitle" className={styles.subtitle}>
          These codes let you sign in if you ever lose access to your password. Save them now —
          we will not show them again.
        </p>

        <div className={styles.codes}>
          {codes.map((code) => (
            <div key={code} className={styles.code}>{code}</div>
          ))}
        </div>

        <div className={styles.buttonRow}>
          <button type="button" onClick={handleCopy} className={styles.secondaryButton}>
            {copied ? 'Copied ✓' : 'Copy to clipboard'}
          </button>
          <button type="button" onClick={handleDownload} className={styles.secondaryButton}>
            Download .txt
          </button>
        </div>

        <label className={styles.ack}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I have saved these codes somewhere safe. I understand I will not see them again.
          </span>
        </label>

        <button
          type="button"
          onClick={onContinue}
          disabled={!acknowledged}
          className={styles.primaryButton}
        >
          Continue to EternalOS
        </button>
      </div>
    </div>
  );
}
