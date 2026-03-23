/**
 * PreferencesWindow - Classic Mac OS Control Panel style preferences
 *
 * Features:
 * - Account info display (username, email, member since)
 * - Display name editing
 * - Wallpaper selection (integrated from WallpaperPicker)
 * - Sound settings (enable/disable, volume)
 * - Classic Mac tabbed interface
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useSoundStore } from '../../stores/soundStore';
import { listSounds, type SoundAsset } from '../../services/api';
import SoundPackEditor from '../sound/SoundPackEditor';
import { fetchAnalytics, type AnalyticsData } from '../../services/api';
import { isApiConfigured, fetchQuota, updateProfile, type QuotaInfo } from '../../services/api';
import styles from './PreferencesWindow.module.css';

type TabId = 'account' | 'sound';

export function PreferencesWindow() {
  const { user, profile, setAnalyticsEnabled, changePassword, changeUsername, sendVerificationEmail } = useAuthStore();
  const { enabled: soundEnabled, volume, setEnabled: setSoundEnabled, setVolume, playSound } = useSoundStore();
  const [soundAssets, setSoundAssets] = useState<SoundAsset[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('account');
  const [displayName, setDisplayName] = useState(profile?.displayName || '');
  const [isEditingName, setIsEditingName] = useState(false);
  // uploadProgress and uploadError moved to AppearancePanel
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [hideWatermark, setHideWatermark] = useState(profile?.hideWatermark || false);
  const [watermarkSaving, setWatermarkSaving] = useState(false);
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // fileInputRef removed — wallpaper upload moved to AppearancePanel

  // Change password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Change username state
  const [newUsername, setNewUsername] = useState('');
  const [usernamePassword, setUsernamePassword] = useState('');
  const [usernameLoading, setUsernameLoading] = useState(false);
  const [usernameSuccess, setUsernameSuccess] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  // Email verification state
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifySuccess, setVerifySuccess] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Wallpaper state moved to AppearancePanel

  // Update display name when profile changes
  useEffect(() => {
    setDisplayName(profile?.displayName || '');
  }, [profile?.displayName]);

  // Update watermark setting when profile changes
  useEffect(() => {
    setHideWatermark(profile?.hideWatermark || false);
  }, [profile?.hideWatermark]);

  // Load quota when account tab is active
  useEffect(() => {
    if (activeTab === 'account' && isApiConfigured && !quota && !quotaLoading) {
      setQuotaLoading(true);
      fetchQuota()
        .then(setQuota)
        .catch(console.error)
        .finally(() => setQuotaLoading(false));
    }
  }, [activeTab, quota, quotaLoading]);

  // Fetch analytics when enabled and on account tab
  useEffect(() => {
    if (activeTab === 'account' && profile?.analyticsEnabled && isApiConfigured && !analyticsData && !analyticsLoading) {
      setAnalyticsLoading(true);
      fetchAnalytics()
        .then(setAnalyticsData)
        .catch(console.error)
        .finally(() => setAnalyticsLoading(false));
    }
  }, [activeTab, profile?.analyticsEnabled, analyticsData, analyticsLoading]);

  // Load sound assets when sound tab is active
  const loadSoundAssets = useCallback(() => {
    if (isApiConfigured) {
      listSounds().then(setSoundAssets).catch(console.error);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'sound') {
      loadSoundAssets();
    }
  }, [activeTab, loadSoundAssets]);

  // Focus input when editing
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  const handleSaveDisplayName = useCallback(async () => {
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setDisplayName(profile?.displayName || '');
      setIsEditingName(false);
      return;
    }

    setIsEditingName(false);

    // Save display name via API if it actually changed
    if (trimmedName !== profile?.displayName && isApiConfigured) {
      // Update local state immediately so the UI reflects the change
      if (profile) {
        useAuthStore.setState({
          profile: { ...profile, displayName: trimmedName },
        });
      }

      try {
        await updateProfile({ displayName: trimmedName });
      } catch (error) {
        console.error('Failed to save display name:', error);
        // Revert on error — both local state and input
        if (profile) {
          useAuthStore.setState({
            profile: { ...profile, displayName: profile.displayName },
          });
        }
        setDisplayName(profile?.displayName || '');
      }
    }
  }, [displayName, profile]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSaveDisplayName();
      } else if (e.key === 'Escape') {
        setDisplayName(profile?.displayName || '');
        setIsEditingName(false);
      }
    },
    [handleSaveDisplayName, profile?.displayName]
  );

  const handleWatermarkToggle = useCallback(async (newValue: boolean) => {
    setHideWatermark(newValue);
    if (!isApiConfigured) return;

    setWatermarkSaving(true);
    try {
      await updateProfile({ hideWatermark: newValue });
    } catch (error) {
      console.error('Failed to save watermark setting:', error);
      // Revert on error
      setHideWatermark(!newValue);
    } finally {
      setWatermarkSaving(false);
    }
  }, []);

  // Wallpaper handlers moved to AppearancePanel

  const handleChangePassword = useCallback(async () => {
    setPasswordError(null);
    setPasswordSuccess(null);

    if (!newPassword || !currentPassword) {
      setPasswordError('Please fill in all fields');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    setPasswordLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPasswordSuccess('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setPasswordLoading(false);
    }
  }, [currentPassword, newPassword, confirmNewPassword, changePassword]);

  const handleChangeUsername = useCallback(async () => {
    setUsernameError(null);
    setUsernameSuccess(null);

    if (!newUsername || !usernamePassword) {
      setUsernameError('Please fill in all fields');
      return;
    }
    if (newUsername.length < 3 || newUsername.length > 20) {
      setUsernameError('Username must be 3-20 characters');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(newUsername)) {
      setUsernameError('Username can only contain letters, numbers, hyphens, and underscores');
      return;
    }

    setUsernameLoading(true);
    try {
      await changeUsername(newUsername, usernamePassword);
      setUsernameSuccess('Username changed successfully');
      setNewUsername('');
      setUsernamePassword('');
    } catch (err) {
      setUsernameError(err instanceof Error ? err.message : 'Failed to change username');
    } finally {
      setUsernameLoading(false);
    }
  }, [newUsername, usernamePassword, changeUsername]);

  const handleSendVerification = useCallback(async () => {
    setVerifyError(null);
    setVerifySuccess(null);
    setVerifyLoading(true);
    try {
      await sendVerificationEmail();
      setVerifySuccess('Verification email sent! Check your inbox.');
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Failed to send verification email');
    } finally {
      setVerifyLoading(false);
    }
  }, [sendVerificationEmail]);

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const getQuotaPercentage = (): number => {
    if (!quota) return 0;
    return Math.round((quota.used / quota.limit) * 100);
  };

  return (
    <div className={styles.preferences}>
      {/* Tab bar */}
      <div className={styles.tabBar}>
        <button
          className={`${styles.tab} ${activeTab === 'account' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('account')}
        >
          Account
        </button>
{/* Desktop tab moved to Appearance panel */}
        <button
          className={`${styles.tab} ${activeTab === 'sound' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('sound')}
        >
          Sound
        </button>
      </div>

      {/* Tab content */}
      <div className={styles.content}>
        {activeTab === 'account' && (
          <div className={styles.accountTab}>
            {/* User icon */}
            <div className={styles.userIcon}>
              <svg width="48" height="48" viewBox="0 0 32 32" fill="none">
                <circle cx="16" cy="12" r="6" fill="#808080" />
                <path
                  d="M8 28c0-4.4 3.6-8 8-8s8 3.6 8 8"
                  fill="#808080"
                />
                <rect
                  x="2"
                  y="2"
                  width="28"
                  height="28"
                  stroke="#000000"
                  strokeWidth="2"
                  fill="none"
                  rx="4"
                />
              </svg>
            </div>

            {/* Account info */}
            <div className={styles.infoSection}>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Username:</span>
                <span className={styles.infoValue}>@{user?.username || 'unknown'}</span>
              </div>

              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Display Name:</span>
                {isEditingName ? (
                  <input
                    ref={nameInputRef}
                    type="text"
                    className={styles.nameInput}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    onBlur={handleSaveDisplayName}
                    onKeyDown={handleNameKeyDown}
                    maxLength={30}
                  />
                ) : (
                  <span
                    className={styles.infoValueEditable}
                    onClick={() => setIsEditingName(true)}
                    title="Click to edit"
                  >
                    {displayName || user?.username || 'Not set'}
                  </span>
                )}
              </div>

              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Email:</span>
                <span className={styles.infoValue}>{user?.email || 'unknown'}</span>
              </div>

              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Member Since:</span>
                <span className={styles.infoValue}>{formatDate(profile?.createdAt)}</span>
              </div>
            </div>

            {/* Visitor URL */}
            <div className={styles.visitorSection}>
              <span className={styles.visitorLabel}>Your Public Desktop:</span>
              <div className={styles.visitorUrl}>
                <span className={styles.urlText}>
                  {window.location.origin}/@{user?.username || 'username'}
                </span>
                <button
                  className={styles.copyButton}
                  onClick={() => {
                    navigator.clipboard.writeText(
                      `${window.location.origin}/@${user?.username}`
                    );
                  }}
                  title="Copy URL"
                >
                  Copy
                </button>
              </div>
              {/* Watermark toggle */}
              {isApiConfigured && (
                <label className={styles.watermarkToggle}>
                  <input
                    type="checkbox"
                    checked={hideWatermark}
                    onChange={(e) => handleWatermarkToggle(e.target.checked)}
                    disabled={watermarkSaving}
                    className={styles.checkbox}
                  />
                  <span>Hide "Made with EternalOS" watermark</span>
                </label>
              )}
            </div>

            {/* Analytics Toggle */}
            {isApiConfigured && (
              <div className={styles.analyticsSection}>
                <span className={styles.analyticsLabel}>Visitor Analytics:</span>
                <label className={styles.analyticsToggle}>
                  <input
                    type="checkbox"
                    checked={profile?.analyticsEnabled || false}
                    onChange={(e) => {
                      setAnalyticsEnabled(e.target.checked);
                      // Reset data so it refetches
                      if (e.target.checked) setAnalyticsData(null);
                    }}
                    className={styles.checkbox}
                  />
                  <span>Track desktop visitor count</span>
                </label>
                {profile?.analyticsEnabled && (
                  <div className={styles.analyticsInfo}>
                    {analyticsLoading ? (
                      <span className={styles.analyticsLoading}>Loading...</span>
                    ) : analyticsData ? (
                      <span className={styles.analyticsCount}>
                        Total views: <strong>{analyticsData.totalViews.toLocaleString()}</strong>
                      </span>
                    ) : (
                      <span className={styles.analyticsEmpty}>No data yet</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Storage Quota */}
            {isApiConfigured && (
              <div className={styles.quotaSection}>
                <span className={styles.quotaLabel}>Storage:</span>
                {quotaLoading ? (
                  <span className={styles.quotaLoading}>Loading...</span>
                ) : quota ? (
                  <div className={styles.quotaInfo}>
                    <div className={styles.quotaBar}>
                      <div
                        className={styles.quotaFill}
                        style={{ width: `${getQuotaPercentage()}%` }}
                      />
                    </div>
                    <span className={styles.quotaText}>
                      {formatBytes(quota.used)} of {formatBytes(quota.limit)} used ({getQuotaPercentage()}%)
                    </span>
                    <span className={styles.quotaFiles}>
                      {quota.itemCount} file{quota.itemCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                ) : (
                  <span className={styles.quotaError}>Unable to load quota</span>
                )}
              </div>
            )}

            {/* Email Verification */}
            {isApiConfigured && (
              <div className={styles.accountSection}>
                <div className={styles.accountSectionTitle}>Email Verification</div>
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>Status:</span>
                  <span className={user?.emailVerified ? styles.verifiedBadge : styles.unverifiedBadge}>
                    {user?.emailVerified ? 'Verified' : 'Not Verified'}
                  </span>
                </div>
                {!user?.emailVerified && (
                  <>
                    <button
                      className={styles.accountButton}
                      onClick={handleSendVerification}
                      disabled={verifyLoading}
                    >
                      {verifyLoading ? 'Sending...' : 'Send Verification Email'}
                    </button>
                    {verifySuccess && <div className={styles.accountSuccess}>{verifySuccess}</div>}
                    {verifyError && <div className={styles.accountError}>{verifyError}</div>}
                  </>
                )}
              </div>
            )}

            {/* Change Password */}
            {isApiConfigured && (
              <div className={styles.accountSection}>
                <div className={styles.accountSectionTitle}>Change Password</div>
                <div className={styles.accountFormRow}>
                  <label className={styles.infoLabel}>Current Password:</label>
                  <input
                    type="password"
                    className={styles.accountInput}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Current password"
                  />
                </div>
                <div className={styles.accountFormRow}>
                  <label className={styles.infoLabel}>New Password:</label>
                  <input
                    type="password"
                    className={styles.accountInput}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="New password (min 8 chars)"
                  />
                </div>
                <div className={styles.accountFormRow}>
                  <label className={styles.infoLabel}>Confirm:</label>
                  <input
                    type="password"
                    className={styles.accountInput}
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Confirm new password"
                  />
                </div>
                <button
                  className={styles.accountButton}
                  onClick={handleChangePassword}
                  disabled={passwordLoading}
                >
                  {passwordLoading ? 'Changing...' : 'Change Password'}
                </button>
                {passwordSuccess && <div className={styles.accountSuccess}>{passwordSuccess}</div>}
                {passwordError && <div className={styles.accountError}>{passwordError}</div>}
              </div>
            )}

            {/* Change Username */}
            {isApiConfigured && (
              <div className={styles.accountSection}>
                <div className={styles.accountSectionTitle}>Change Username</div>
                <div className={styles.accountFormRow}>
                  <label className={styles.infoLabel}>New Username:</label>
                  <input
                    type="text"
                    className={styles.accountInput}
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="New username"
                    maxLength={20}
                  />
                </div>
                <div className={styles.accountFormRow}>
                  <label className={styles.infoLabel}>Password:</label>
                  <input
                    type="password"
                    className={styles.accountInput}
                    value={usernamePassword}
                    onChange={(e) => setUsernamePassword(e.target.value)}
                    placeholder="Confirm your password"
                  />
                </div>
                <button
                  className={styles.accountButton}
                  onClick={handleChangeUsername}
                  disabled={usernameLoading}
                >
                  {usernameLoading ? 'Changing...' : 'Change Username'}
                </button>
                {usernameSuccess && <div className={styles.accountSuccess}>{usernameSuccess}</div>}
                {usernameError && <div className={styles.accountError}>{usernameError}</div>}
              </div>
            )}
          </div>
        )}

        {/* Desktop tab removed — wallpaper settings now in Appearance panel */}

        {activeTab === 'sound' && (
          <div className={styles.soundTab}>
            {/* Speaker icon */}
            <div className={styles.soundIcon}>
              <svg width="48" height="48" viewBox="0 0 32 32" fill="none">
                <rect x="4" y="10" width="8" height="12" fill="#808080" stroke="#000" strokeWidth="1" />
                <polygon points="12,10 20,4 20,28 12,22" fill="#808080" stroke="#000" strokeWidth="1" />
                {soundEnabled && (
                  <>
                    <path d="M22 12 Q26 16 22 20" stroke="#000" strokeWidth="2" fill="none" />
                    <path d="M24 8 Q30 16 24 24" stroke="#000" strokeWidth="2" fill="none" />
                  </>
                )}
                {!soundEnabled && (
                  <line x1="22" y1="10" x2="30" y2="22" stroke="#cc0000" strokeWidth="3" />
                )}
              </svg>
            </div>

            <div className={styles.soundSection}>
              {/* Enable/Disable checkbox */}
              <div className={styles.soundRow}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={soundEnabled}
                    onChange={(e) => setSoundEnabled(e.target.checked)}
                    className={styles.checkbox}
                  />
                  <span>Enable system sounds</span>
                </label>
              </div>

              {/* Volume slider */}
              <div className={styles.soundRow}>
                <span className={styles.volumeLabel}>Volume:</span>
                <div className={styles.volumeControl}>
                  <span className={styles.volumeIcon}>🔈</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={volume * 100}
                    onChange={(e) => setVolume(Number(e.target.value) / 100)}
                    className={styles.volumeSlider}
                    disabled={!soundEnabled}
                  />
                  <span className={styles.volumeIcon}>🔊</span>
                </div>
                <span className={styles.volumeValue}>{Math.round(volume * 100)}%</span>
              </div>

              {/* Test sounds */}
              <div className={styles.soundRow}>
                <span className={styles.testLabel}>Test Sounds:</span>
                <div className={styles.testButtons}>
                  <button
                    className={styles.testButton}
                    onClick={() => playSound('click')}
                    disabled={!soundEnabled}
                  >
                    Click
                  </button>
                  <button
                    className={styles.testButton}
                    onClick={() => playSound('windowOpen')}
                    disabled={!soundEnabled}
                  >
                    Window
                  </button>
                  <button
                    className={styles.testButton}
                    onClick={() => playSound('alert')}
                    disabled={!soundEnabled}
                  >
                    Alert
                  </button>
                  <button
                    className={styles.testButton}
                    onClick={() => playSound('trash')}
                    disabled={!soundEnabled}
                  >
                    Trash
                  </button>
                </div>
              </div>

              {/* Sound pack editor */}
              {soundEnabled && (
                <div style={{ marginTop: 8, borderTop: '1px solid var(--shadow)', paddingTop: 8 }}>
                  <SoundPackEditor
                    soundAssets={soundAssets}
                    onAssetsChange={loadSoundAssets}
                  />
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
