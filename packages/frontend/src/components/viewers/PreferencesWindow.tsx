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
import { fetchAnalytics, type AnalyticsData } from '../../services/api';
import { WALLPAPER_OPTIONS, type WallpaperId } from '../desktop/Desktop';
import { uploadWallpaper, isApiConfigured, getWallpaperUrl, fetchQuota, updateProfile, type QuotaInfo } from '../../services/api';
import styles from './PreferencesWindow.module.css';

type TabId = 'account' | 'desktop' | 'sound';

export function PreferencesWindow() {
  const { user, profile, setWallpaper, setAnalyticsEnabled } = useAuthStore();
  const { enabled: soundEnabled, volume, setEnabled: setSoundEnabled, setVolume, playSound } = useSoundStore();
  const [activeTab, setActiveTab] = useState<TabId>('account');
  const [displayName, setDisplayName] = useState(profile?.displayName || '');
  const [isEditingName, setIsEditingName] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [hideWatermark, setHideWatermark] = useState(profile?.hideWatermark || false);
  const [watermarkSaving, setWatermarkSaving] = useState(false);
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentWallpaper = profile?.wallpaper || 'default';
  const isCustomWallpaper = currentWallpaper.startsWith('custom:');

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

  const handleSelectWallpaper = useCallback(
    (id: WallpaperId) => {
      setWallpaper(id);
      setUploadError(null);
    },
    [setWallpaper]
  );

  const handleWallpaperUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Validate file type
      if (!['image/jpeg', 'image/png'].includes(file.type)) {
        setUploadError('Only JPG and PNG files are allowed');
        return;
      }

      // Validate file size (2MB max)
      if (file.size > 2 * 1024 * 1024) {
        setUploadError('File must be smaller than 2MB');
        return;
      }

      setUploadError(null);
      setUploadProgress(0);

      try {
        const response = await uploadWallpaper(file, (progress) => {
          setUploadProgress(progress);
        });

        // Update the wallpaper in auth store
        setWallpaper(response.wallpaper);
        setUploadProgress(null);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Upload failed');
        setUploadProgress(null);
      }

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [setWallpaper]
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

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
        <button
          className={`${styles.tab} ${activeTab === 'desktop' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('desktop')}
        >
          Desktop
        </button>
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
          </div>
        )}

        {activeTab === 'desktop' && (
          <div className={styles.desktopTab}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Desktop Pattern</span>
            </div>
            <div className={styles.patternGrid}>
              {WALLPAPER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  className={`${styles.patternButton} ${currentWallpaper === option.id ? styles.selected : ''}`}
                  onClick={() => handleSelectWallpaper(option.id)}
                  title={option.name}
                >
                  <div className={`${styles.patternPreview} wallpaper-${option.id}`} />
                  <span className={styles.patternName}>{option.name}</span>
                </button>
              ))}
            </div>

            {/* Custom Wallpaper Upload Section */}
            {isApiConfigured && (
              <div className={styles.customWallpaperSection}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionTitle}>Custom Wallpaper</span>
                </div>

                {/* Current custom wallpaper preview */}
                {isCustomWallpaper && (
                  <div className={styles.customWallpaperPreview}>
                    <img
                      src={getWallpaperUrl(currentWallpaper)}
                      alt="Current custom wallpaper"
                      className={styles.customWallpaperImage}
                    />
                    <span className={styles.customWallpaperLabel}>Current custom wallpaper</span>
                  </div>
                )}

                {/* Upload button */}
                <div className={styles.uploadSection}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png"
                    onChange={handleWallpaperUpload}
                    className={styles.hiddenFileInput}
                  />
                  <button
                    className={styles.uploadButton}
                    onClick={handleUploadClick}
                    disabled={uploadProgress !== null}
                  >
                    {uploadProgress !== null ? `Uploading... ${uploadProgress}%` : 'Upload Image'}
                  </button>
                  <span className={styles.uploadHint}>JPG or PNG, max 2MB</span>
                </div>

                {/* Upload error */}
                {uploadError && (
                  <div className={styles.uploadError}>{uploadError}</div>
                )}
              </div>
            )}
          </div>
        )}

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
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
