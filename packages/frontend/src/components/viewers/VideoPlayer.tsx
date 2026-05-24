import { useState, useRef, useEffect, useCallback } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { getFileUrl, isApiConfigured } from '../../services/api';
import { useFileTokenVersion } from '../../hooks/useFileToken';
import styles from './VideoPlayer.module.css';

interface VideoPlayerProps {
  itemId: string;
  r2Key?: string;
  name?: string;
}

// Available playback speeds
const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * VideoPlayer - Classic Mac OS-style video player
 * Features:
 * - Bordered video display with playback controls
 * - Volume control with mute toggle
 * - Playback speed control
 * - Keyboard shortcuts (space, arrows, m, f)
 * - Error retry functionality
 */
export function VideoPlayer({ itemId, r2Key: propR2Key, name: propName }: VideoPlayerProps) {
  // Get item from store as fallback (for backwards compatibility)
  const item = useDesktopStore((state) => state.getItem(itemId));
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  // Prefer prop r2Key, fall back to store item
  const r2Key = propR2Key || item?.r2Key;
  const fileName = propName || item?.name || 'Video';

  // Re-render when the file token rotates so the video src stays signed.
  useFileTokenVersion();
  const videoUrl = r2Key && isApiConfigured
    ? getFileUrl(r2Key)
    : null;

  // Format time as MM:SS
  const formatTime = (seconds: number): string => {
    if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Handle play/pause
  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;

    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play().catch((err) => {
        console.error('Failed to play video:', err);
        setError('Failed to play video');
      });
    }
  }, [isPlaying]);

  // Handle progress bar click
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current || !duration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const newTime = percentage * duration;

    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  }, [duration]);

  // Toggle fullscreen
  const toggleFullscreen = useCallback(() => {
    if (!videoRef.current) return;

    if (document.fullscreenElement) {
      document.exitFullscreen();
      setIsFullscreen(false);
    } else {
      videoRef.current.requestFullscreen().catch((err) => {
        console.error('Failed to enter fullscreen:', err);
      });
      setIsFullscreen(true);
    }
  }, []);

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (!videoRef.current) return;
    const newMuted = !isMuted;
    videoRef.current.muted = newMuted;
    setIsMuted(newMuted);
  }, [isMuted]);

  // Handle volume change
  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return;
    const newVolume = parseFloat(e.target.value);
    videoRef.current.volume = newVolume;
    setVolume(newVolume);
    if (newVolume > 0 && isMuted) {
      videoRef.current.muted = false;
      setIsMuted(false);
    }
  }, [isMuted]);

  // Handle playback speed change
  const handleSpeedChange = useCallback((speed: number) => {
    if (!videoRef.current) return;
    videoRef.current.playbackRate = speed;
    setPlaybackSpeed(speed);
    setShowSpeedMenu(false);
  }, []);

  // Seek forward/backward
  const seek = useCallback((seconds: number) => {
    if (!videoRef.current) return;
    const newTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + seconds));
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  }, [duration]);

  // Retry loading video
  const handleRetry = useCallback(() => {
    setError(null);
    setIsLoading(true);
    if (videoRef.current) {
      videoRef.current.load();
    }
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if this container or video is focused
      if (!container.contains(document.activeElement) && document.activeElement !== document.body) {
        return;
      }

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seek(-5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seek(5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (videoRef.current) {
            const newVol = Math.min(1, volume + 0.1);
            videoRef.current.volume = newVol;
            setVolume(newVol);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (videoRef.current) {
            const newVol = Math.max(0, volume - 0.1);
            videoRef.current.volume = newVol;
            setVolume(newVol);
          }
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
      }
    };

    // Make container focusable
    container.tabIndex = 0;
    container.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [togglePlay, seek, volume, toggleMute, toggleFullscreen]);

  // Video event handlers
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleTimeUpdate = () => setCurrentTime(video.currentTime);
    const handleDurationChange = () => setDuration(video.duration);
    const handleLoadedData = () => setIsLoading(false);
    const handleError = () => {
      setError('Failed to load video file');
      setIsLoading(false);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      video.currentTime = 0;
    };
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('durationchange', handleDurationChange);
    video.addEventListener('loadeddata', handleLoadedData);
    video.addEventListener('error', handleError);
    video.addEventListener('ended', handleEnded);
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('durationchange', handleDurationChange);
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('error', handleError);
      video.removeEventListener('ended', handleEnded);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Show error if no r2Key available (item not found in store AND no prop passed)
  if (!r2Key && !item) {
    return (
      <div className={styles.container}>
        <div className={styles.errorState}>
          <div className={styles.errorIcon}>!</div>
          <p>Video file not found</p>
        </div>
      </div>
    );
  }

  if (!videoUrl) {
    return (
      <div className={styles.container}>
        <div className={styles.demoMode}>
          <div className={styles.demoIcon}>
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
              <rect x="8" y="12" width="48" height="36" fill="#2a2a2a" stroke="#000" strokeWidth="2"/>
              <rect x="12" y="16" width="40" height="28" fill="#1a1a1a"/>
              <polygon points="28,24 28,40 40,32" fill="#808080"/>
              <rect x="6" y="48" width="12" height="8" fill="#808080" stroke="#000" strokeWidth="1"/>
              <rect x="46" y="48" width="12" height="8" fill="#808080" stroke="#000" strokeWidth="1"/>
            </svg>
          </div>
          <p className={styles.demoText}>{fileName}</p>
          <p className={styles.demoSubtext}>Demo mode: No video data</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.errorState}>
          <div className={styles.errorIcon}>!</div>
          <p>{error}</p>
          <button className={styles.retryButton} onClick={handleRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className={styles.container} ref={containerRef}>
      {/* Video display */}
      <div className={styles.videoWrapper} onDoubleClick={toggleFullscreen}>
        <video
          ref={videoRef}
          src={videoUrl}
          preload="metadata"
          className={styles.video}
          onClick={togglePlay}
        />
        {isLoading && (
          <div className={styles.loadingOverlay}>
            <div className={styles.loadingSpinner} />
            <span>Loading...</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className={styles.controls}>
        {/* Play/Pause button */}
        <button
          className={styles.controlButton}
          onClick={togglePlay}
          disabled={isLoading}
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        >
          {isPlaying ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="2" width="4" height="12" />
              <rect x="9" y="2" width="4" height="12" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2L14 8L4 14V2Z" />
            </svg>
          )}
        </button>

        {/* Volume control */}
        <button
          className={styles.controlButton}
          onClick={toggleMute}
          title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            {isMuted || volume === 0 ? (
              <>
                <path d="M2 5H5L9 1V15L5 11H2V5Z" />
                <path d="M12 6L15 9M15 6L12 9" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </>
            ) : (
              <>
                <path d="M2 5H5L9 1V15L5 11H2V5Z" />
                <path d="M11 4C12.5 5.5 12.5 10.5 11 12" stroke="currentColor" strokeWidth="1.5" fill="none" />
                {volume > 0.5 && (
                  <path d="M13 2C15.5 4.5 15.5 11.5 13 14" stroke="currentColor" strokeWidth="1.5" fill="none" />
                )}
              </>
            )}
          </svg>
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={isMuted ? 0 : volume}
          onChange={handleVolumeChange}
          className={styles.volumeSlider}
          title={`Volume: ${Math.round(volume * 100)}%`}
        />

        {/* Progress bar */}
        <div className={styles.progressContainer} onClick={handleProgressClick}>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Time display */}
        <div className={styles.timeDisplay}>
          <span>{formatTime(currentTime)}</span>
          <span className={styles.timeSeparator}>/</span>
          <span>{formatTime(duration)}</span>
        </div>

        {/* Speed control */}
        <div className={styles.speedControl}>
          <button
            className={styles.controlButton}
            onClick={() => setShowSpeedMenu(!showSpeedMenu)}
            title="Playback speed"
          >
            <span className={styles.speedLabel}>{playbackSpeed}x</span>
          </button>
          {showSpeedMenu && (
            <div className={styles.speedMenu}>
              {PLAYBACK_SPEEDS.map((speed) => (
                <button
                  key={speed}
                  className={`${styles.speedOption} ${speed === playbackSpeed ? styles.speedOptionActive : ''}`}
                  onClick={() => handleSpeedChange(speed)}
                >
                  {speed}x
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Fullscreen button */}
        <button
          className={styles.controlButton}
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            {isFullscreen ? (
              <>
                <path d="M2 6H4V2H8V0H2V6Z" />
                <path d="M14 6V2H10V0H16V6H14Z" />
                <path d="M14 10H16V16H10V14H14V10Z" />
                <path d="M2 10V14H6V16H0V10H2Z" />
              </>
            ) : (
              <>
                <path d="M0 5V0H5V2H2V5H0Z" />
                <path d="M16 5H14V2H11V0H16V5Z" />
                <path d="M16 11V16H11V14H14V11H16Z" />
                <path d="M0 11H2V14H5V16H0V11Z" />
              </>
            )}
          </svg>
        </button>
      </div>
    </div>
  );
}
