/**
 * RecoveryCodesDialog — one-time reveal of the 10 recovery codes generated
 * at signup. User must acknowledge saving them before continuing to the
 * desktop. The server will not show these again.
 */

import { useState } from 'react';

interface RecoveryCodesDialogProps {
  codes: string[];
  username: string;
  onContinue: () => void;
}

export function RecoveryCodesDialog({ codes, username, onContinue }: RecoveryCodesDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

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
    <div style={overlayStyle} role="dialog" aria-labelledby="recovery-codes-title" aria-modal="true">
      <div style={dialogStyle}>
        <h2 id="recovery-codes-title" style={titleStyle}>Save your recovery codes</h2>
        <p style={subtitleStyle}>
          These codes let you sign in if you ever lose access to your password. Save them now —
          we will not show them again.
        </p>

        <div style={codesContainerStyle}>
          {codes.map((code) => (
            <div key={code} style={codeStyle}>{code}</div>
          ))}
        </div>

        <div style={buttonRowStyle}>
          <button type="button" onClick={handleCopy} style={secondaryButtonStyle}>
            {copied ? 'Copied ✓' : 'Copy to clipboard'}
          </button>
          <button type="button" onClick={handleDownload} style={secondaryButtonStyle}>
            Download .txt
          </button>
        </div>

        <label style={ackStyle}>
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
          style={{
            ...primaryButtonStyle,
            opacity: acknowledged ? 1 : 0.5,
            cursor: acknowledged ? 'pointer' : 'not-allowed',
          }}
        >
          Continue to EternalOS
        </button>
      </div>
    </div>
  );
}

// Inline styles keep the component drop-in — no new CSS module to wire.
const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
  padding: 16,
};

const dialogStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #000',
  borderRadius: 6,
  padding: 24,
  maxWidth: 520,
  width: '100%',
  boxShadow: '4px 4px 0 rgba(0,0,0,0.3)',
  fontFamily: 'var(--font-system, system-ui), sans-serif',
};

const titleStyle: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: 18,
  fontWeight: 700,
};

const subtitleStyle: React.CSSProperties = {
  margin: '0 0 16px',
  color: '#444',
  fontSize: 14,
  lineHeight: 1.5,
};

const codesContainerStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: 8,
  padding: 12,
  background: '#f6f6f6',
  border: '1px solid #ccc',
  borderRadius: 4,
  marginBottom: 12,
};

const codeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, "Monaco", monospace)',
  fontSize: 14,
  letterSpacing: 1,
  padding: '4px 8px',
  background: '#fff',
  border: '1px solid #ddd',
  borderRadius: 2,
  textAlign: 'center',
  userSelect: 'all',
};

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginBottom: 16,
};

const secondaryButtonStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 12px',
  background: '#fff',
  border: '1px solid #000',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 13,
  fontFamily: 'inherit',
};

const ackStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-start',
  marginBottom: 16,
  fontSize: 13,
  lineHeight: 1.4,
  cursor: 'pointer',
};

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 16px',
  background: '#000',
  color: '#fff',
  border: '1px solid #000',
  borderRadius: 3,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
};
