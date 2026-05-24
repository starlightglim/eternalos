import { useState, useRef, useEffect, useCallback } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { getFileUrl, isApiConfigured } from '../../services/api';
import { useFileTokenVersion } from '../../hooks/useFileToken';
import styles from './AudioPlayer.module.css';

interface AudioPlayerProps {
  itemId: string;
  r2Key?: string;
  name?: string;
}

/**
 * AudioPlayer - Classic QuickTime-style audio player
 * Features:
 * - Play/pause with spacebar
 * - Volume control slider with mute toggle
 * - Loop toggle button
 * - Progress bar with seeking
 * - Keyboard shortcuts (Space, M, L, Arrow keys)
 */
export function AudioPlayer({ itemId, r2Key: propR2Key, name: propName }: AudioPlayerProps) {
  // Get item from store as fallback (for backwards compatibility)
  const item = useDesktopStore((state) => state.getItem(itemId));
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isLooping, setIsLooping] = useState(false);

  // Prefer prop r2Key, fall back to store item
  const r2Key = propR2Key || item?.r2Key;
  const fileName = propName || item?.name || 'Audio';

  // Re-render when the file token rotates so the audio src stays signed.
  useFileTokenVersion();
  const audioUrl = r2Key && isApiConfigured
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
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch((err) => {
        console.error('Failed to play audio:', err);
        setError('Failed to play audio');
      });
    }
  }, [isPlaying]);

  // Handle volume change
  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (audioRef.current) {
      audioRef.current.volume = newVolume;
    }
    // Unmute if volume is changed while muted
    if (isMuted && newVolume > 0) {
      setIsMuted(false);
      if (audioRef.current) {
        audioRef.current.muted = false;
      }
    }
  }, [isMuted]);

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (!audioRef.current) return;
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    audioRef.current.muted = newMuted;
  }, [isMuted]);

  // Toggle loop
  const toggleLoop = useCallback(() => {
    if (!audioRef.current) return;
    const newLooping = !isLooping;
    setIsLooping(newLooping);
    audioRef.current.loop = newLooping;
  }, [isLooping]);

  // Handle progress bar click
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const newTime = percentage * duration;

    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  }, [duration]);

  // Seek forward/backward
  const seek = useCallback((seconds: number) => {
    if (!audioRef.current) return;
    const newTime = Math.max(0, Math.min(duration, audioRef.current.currentTime + seconds));
    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  }, [duration]);

  // Adjust volume
  const adjustVolume = useCallback((delta: number) => {
    const newVolume = Math.max(0, Math.min(1, volume + delta));
    setVolume(newVolume);
    if (audioRef.current) {
      audioRef.current.volume = newVolume;
    }
    if (isMuted && newVolume > 0) {
      setIsMuted(false);
      if (audioRef.current) {
        audioRef.current.muted = false;
      }
    }
  }, [volume, isMuted]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if this container or its children are focused
      if (!containerRef.current?.contains(document.activeElement) &&
          document.activeElement !== containerRef.current) {
        return;
      }

      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          toggleLoop();
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
          adjustVolume(0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          adjustVolume(-0.1);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, toggleMute, toggleLoop, seek, adjustVolume]);

  // Audio event handlers
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleDurationChange = () => setDuration(audio.duration);
    const handleLoadedData = () => setIsLoading(false);
    const handleError = () => {
      setError('Failed to load audio file');
      setIsLoading(false);
    };
    const handleEnded = () => {
      if (!isLooping) {
        setIsPlaying(false);
        setCurrentTime(0);
        audio.currentTime = 0;
      }
    };

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('loadeddata', handleLoadedData);
    audio.addEventListener('error', handleError);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('loadeddata', handleLoadedData);
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [isLooping]);

  // Show error if no r2Key available (item not found in store AND no prop passed)
  if (!r2Key && !item) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>Audio file not found</div>
      </div>
    );
  }

  if (!audioUrl) {
    return (
      <div className={styles.container}>
        <div className={styles.demoMode}>
          <div className={styles.demoIcon}>
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <rect x="8" y="8" width="32" height="32" fill="#C0C0C0" stroke="#000" strokeWidth="2"/>
              <circle cx="24" cy="24" r="10" fill="#808080" stroke="#000" strokeWidth="1"/>
              <circle cx="24" cy="24" r="4" fill="#000"/>
              <path d="M20 16L20 32" stroke="#000" strokeWidth="2"/>
              <path d="M28 16L28 32" stroke="#000" strokeWidth="2"/>
            </svg>
          </div>
          <p className={styles.demoText}>{fileName}</p>
          <p className={styles.demoSubtext}>Demo mode: No audio data</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>{error}</div>
      </div>
    );
  }

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className={styles.container} ref={containerRef} tabIndex={0}>
      <audio ref={audioRef} src={audioUrl} preload="metadata" />

      {/* QuickTime-style player */}
      <div className={styles.player}>
        {/* CD/Record visualization */}
        <div className={styles.discContainer}>
          <div className={`${styles.disc} ${isPlaying ? styles.spinning : ''}`}>
            <div className={styles.discCenter} />
            <div className={styles.discGrooves} />
          </div>
        </div>

        {/* Main Controls */}
        <div className={styles.controls}>
          {/* Play/Pause button */}
          <button
            className={styles.playButton}
            onClick={togglePlay}
            disabled={isLoading}
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          >
            {isLoading ? (
              <span className={styles.loading}>...</span>
            ) : isPlaying ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="2" width="4" height="12" />
                <rect x="9" y="2" width="4" height="12" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 2L14 8L4 14V2Z" />
              </svg>
            )}
          </button>

          {/* Progress bar */}
          <div className={styles.progressContainer} onClick={handleProgressClick}>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressFill}
                style={{ width: `${progressPercent}%` }}
              />
              <div
                className={styles.progressHandle}
                style={{ left: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* Time display */}
          <div className={styles.timeDisplay}>
            <span className={styles.currentTime}>{formatTime(currentTime)}</span>
            <span className={styles.timeSeparator}>/</span>
            <span className={styles.totalTime}>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Secondary Controls */}
        <div className={styles.secondaryControls}>
          {/* Loop button */}
          <button
            className={`${styles.controlButton} ${isLooping ? styles.active : ''}`}
            onClick={toggleLoop}
            title={isLooping ? 'Disable Loop (L)' : 'Enable Loop (L)'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 2L14 5L11 8" fill="none" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M5 14L2 11L5 8" fill="none" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M14 5H6C4 5 2 6.5 2 8.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M2 11H10C12 11 14 9.5 14 7.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </button>

          {/* Volume controls */}
          <div className={styles.volumeControls}>
            <button
              className={`${styles.controlButton} ${isMuted ? styles.muted : ''}`}
              onClick={toggleMute}
              title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
            >
              {isMuted || volume === 0 ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M2 5H4L8 2V14L4 11H2V5Z"/>
                  <line x1="11" y1="5" x2="15" y2="11" stroke="currentColor" strokeWidth="1.5"/>
                  <line x1="15" y1="5" x2="11" y2="11" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
              ) : volume < 0.5 ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M2 5H4L8 2V14L4 11H2V5Z"/>
                  <path d="M11 6C12 7 12 9 11 10" fill="none" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M2 5H4L8 2V14L4 11H2V5Z"/>
                  <path d="M11 6C12 7 12 9 11 10" fill="none" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M13 4C15 6 15 10 13 12" fill="none" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              className={styles.volumeSlider}
              title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
            />
          </div>
        </div>

        {/* Track name */}
        <div className={styles.trackName}>{fileName}</div>
      </div>
    </div>
  );
}
