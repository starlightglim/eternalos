/**
 * Pixel Art Icons for EternalOS
 * 32x32 pixel art icons inspired by classic Macintosh
 * Using inline SVG for pixel-perfect rendering
 */

interface IconProps {
  className?: string;
  size?: number;
}

/**
 * Folder Icon - Classic Mac folder with tab on top-left
 */
export function FolderIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Tab */}
      <rect x="2" y="6" width="10" height="4" fill="#FFCC00" stroke="#000" strokeWidth="1" />
      {/* Main body */}
      <rect x="2" y="9" width="28" height="18" fill="#FFCC00" stroke="#000" strokeWidth="1" />
      {/* Highlight */}
      <line x1="3" y1="10" x2="29" y2="10" stroke="#FFE066" strokeWidth="1" />
      <line x1="3" y1="10" x2="3" y2="26" stroke="#FFE066" strokeWidth="1" />
      {/* Shadow */}
      <line x1="29" y1="10" x2="29" y2="26" stroke="#CC9900" strokeWidth="1" />
      <line x1="3" y1="26" x2="29" y2="26" stroke="#CC9900" strokeWidth="1" />
    </svg>
  );
}

/**
 * Document/Text File Icon
 */
export function TextFileIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Page */}
      <path
        d="M6 2 L6 30 L26 30 L26 8 L20 2 Z"
        fill="#FFFFFF"
        stroke="#000"
        strokeWidth="1"
      />
      {/* Folded corner */}
      <path d="M20 2 L20 8 L26 8" fill="#C0C0C0" stroke="#000" strokeWidth="1" />
      {/* Text lines */}
      <line x1="9" y1="12" x2="23" y2="12" stroke="#000" strokeWidth="1" />
      <line x1="9" y1="16" x2="23" y2="16" stroke="#000" strokeWidth="1" />
      <line x1="9" y1="20" x2="18" y2="20" stroke="#000" strokeWidth="1" />
      <line x1="9" y1="24" x2="20" y2="24" stroke="#000" strokeWidth="1" />
    </svg>
  );
}

/**
 * Image File Icon
 */
export function ImageFileIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Frame */}
      <rect x="4" y="4" width="24" height="24" fill="#FFFFFF" stroke="#000" strokeWidth="2" />
      {/* Inner border */}
      <rect x="6" y="6" width="20" height="20" fill="#E0E0E0" stroke="#808080" strokeWidth="1" />
      {/* Mountains/landscape */}
      <polygon points="8,22 14,14 20,20 26,12 26,24 8,24" fill="#008000" />
      {/* Sun */}
      <circle cx="22" cy="12" r="3" fill="#FFCC00" />
    </svg>
  );
}

/**
 * Audio File Icon - Speaker/music note style
 */
export function AudioFileIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* CD/Record disc */}
      <circle cx="16" cy="16" r="12" fill="#2a2a2a" stroke="#000" strokeWidth="1" />
      <circle cx="16" cy="16" r="10" fill="#3a3a3a" stroke="none" />
      {/* Grooves */}
      <circle cx="16" cy="16" r="8" fill="none" stroke="#222" strokeWidth="1" />
      <circle cx="16" cy="16" r="6" fill="none" stroke="#222" strokeWidth="1" />
      {/* Center hole */}
      <circle cx="16" cy="16" r="3" fill="#808080" stroke="#000" strokeWidth="1" />
      <circle cx="16" cy="16" r="1" fill="#000" />
      {/* Shine */}
      <path d="M10 10 Q12 8 14 10" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
    </svg>
  );
}

/**
 * Video File Icon - Film reel / clapperboard style
 */
export function VideoFileIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Film frame body */}
      <rect x="4" y="6" width="24" height="20" fill="#2a2a2a" stroke="#000" strokeWidth="1" />
      {/* Screen area */}
      <rect x="8" y="10" width="16" height="12" fill="#4080ff" stroke="#000" strokeWidth="1" />
      {/* Play triangle */}
      <polygon points="14,13 14,19 19,16" fill="#fff" />
      {/* Film sprocket holes - left */}
      <rect x="5" y="8" width="2" height="2" fill="#808080" />
      <rect x="5" y="12" width="2" height="2" fill="#808080" />
      <rect x="5" y="16" width="2" height="2" fill="#808080" />
      <rect x="5" y="20" width="2" height="2" fill="#808080" />
      {/* Film sprocket holes - right */}
      <rect x="25" y="8" width="2" height="2" fill="#808080" />
      <rect x="25" y="12" width="2" height="2" fill="#808080" />
      <rect x="25" y="16" width="2" height="2" fill="#808080" />
      <rect x="25" y="20" width="2" height="2" fill="#808080" />
    </svg>
  );
}

/**
 * PDF File Icon - Document with red PDF badge
 */
export function PDFFileIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Page */}
      <path
        d="M6 2 L6 30 L26 30 L26 8 L20 2 Z"
        fill="#FFFFFF"
        stroke="#000"
        strokeWidth="1"
      />
      {/* Folded corner */}
      <path d="M20 2 L20 8 L26 8" fill="#C0C0C0" stroke="#000" strokeWidth="1" />
      {/* PDF badge background */}
      <rect x="8" y="14" width="16" height="10" fill="#cc0000" stroke="#000" strokeWidth="1" />
      {/* PDF text */}
      <text x="10" y="22" fontFamily="sans-serif" fontSize="7" fontWeight="bold" fill="#fff">PDF</text>
    </svg>
  );
}

/**
 * Link/URL Icon
 */
export function LinkIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Globe */}
      <circle cx="16" cy="16" r="12" fill="#4169E1" stroke="#000" strokeWidth="1" />
      {/* Latitude lines */}
      <ellipse cx="16" cy="16" rx="12" ry="5" fill="none" stroke="#000" strokeWidth="1" />
      <line x1="4" y1="16" x2="28" y2="16" stroke="#000" strokeWidth="1" />
      {/* Longitude lines */}
      <ellipse cx="16" cy="16" rx="5" ry="12" fill="none" stroke="#000" strokeWidth="1" />
      <line x1="16" y1="4" x2="16" y2="28" stroke="#000" strokeWidth="1" />
      {/* Highlight */}
      <circle cx="12" cy="12" r="3" fill="rgba(255,255,255,0.3)" />
    </svg>
  );
}

/**
 * App Icon - Small window/application frame
 */
export function AppIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      <rect x="4" y="5" width="24" height="22" fill="#f4f1dc" stroke="#000" strokeWidth="1" />
      <rect x="4" y="5" width="24" height="5" fill="#1f4e79" stroke="#000" strokeWidth="1" />
      <rect x="7" y="13" width="18" height="11" fill="#ffffff" stroke="#808080" strokeWidth="1" />
      <rect x="9" y="15" width="5" height="3" fill="#5b8bd9" />
      <rect x="16" y="15" width="7" height="1" fill="#808080" />
      <rect x="16" y="17" width="5" height="1" fill="#808080" />
      <rect x="9" y="20" width="14" height="2" fill="#d9d9d9" />
      <rect x="6" y="6" width="2" height="2" fill="#ffffff" />
      <rect x="24" y="6" width="2" height="2" fill="#ffffff" />
    </svg>
  );
}

/**
 * Trash Icon (Empty)
 */
export function TrashEmptyIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Lid */}
      <rect x="6" y="4" width="20" height="4" fill="#C0C0C0" stroke="#000" strokeWidth="1" />
      <rect x="12" y="2" width="8" height="3" fill="#C0C0C0" stroke="#000" strokeWidth="1" />
      {/* Body */}
      <path
        d="M8 8 L10 28 L22 28 L24 8 Z"
        fill="#C0C0C0"
        stroke="#000"
        strokeWidth="1"
      />
      {/* Ridges */}
      <line x1="12" y1="10" x2="12" y2="26" stroke="#808080" strokeWidth="1" />
      <line x1="16" y1="10" x2="16" y2="26" stroke="#808080" strokeWidth="1" />
      <line x1="20" y1="10" x2="20" y2="26" stroke="#808080" strokeWidth="1" />
    </svg>
  );
}

/**
 * Trash Icon (Full)
 */
export function TrashFullIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Paper sticking out */}
      <rect x="10" y="0" width="6" height="6" fill="#FFFFFF" stroke="#000" strokeWidth="1" transform="rotate(-15 13 3)" />
      <rect x="16" y="1" width="5" height="5" fill="#FFFFFF" stroke="#000" strokeWidth="1" transform="rotate(10 18 3)" />
      {/* Lid (slightly open) */}
      <rect x="6" y="5" width="20" height="4" fill="#C0C0C0" stroke="#000" strokeWidth="1" transform="rotate(-5 16 7)" />
      <rect x="12" y="3" width="8" height="3" fill="#C0C0C0" stroke="#000" strokeWidth="1" transform="rotate(-5 16 4)" />
      {/* Body */}
      <path
        d="M8 9 L10 28 L22 28 L24 9 Z"
        fill="#C0C0C0"
        stroke="#000"
        strokeWidth="1"
      />
      {/* Ridges */}
      <line x1="12" y1="11" x2="12" y2="26" stroke="#808080" strokeWidth="1" />
      <line x1="16" y1="11" x2="16" y2="26" stroke="#808080" strokeWidth="1" />
      <line x1="20" y1="11" x2="20" y2="26" stroke="#808080" strokeWidth="1" />
    </svg>
  );
}

/**
 * Widget Icon - Puzzle piece style for desktop widgets
 */
export function WidgetIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Main puzzle piece body */}
      <path
        d="M4 8 L10 8 L10 6 Q12 4 14 6 L14 8 L24 8 L24 14 L26 14 Q28 16 26 18 L24 18 L24 28 L14 28 L14 26 Q12 24 10 26 L10 28 L4 28 Z"
        fill="#9B59B6"
        stroke="#000"
        strokeWidth="1"
      />
      {/* Highlight */}
      <path
        d="M5 9 L10 9 L10 7"
        fill="none"
        stroke="#C39BD3"
        strokeWidth="1"
      />
      {/* Inner detail */}
      <rect x="12" y="14" width="8" height="8" fill="#8E44AD" stroke="none" />
      {/* Sparkle effect */}
      <rect x="8" y="12" width="2" height="2" fill="#FFFFFF" />
      <rect x="20" y="20" width="2" height="2" fill="#FFFFFF" />
    </svg>
  );
}

/**
 * Desk Assistant Icon - Classic Mac terminal/computer icon
 */
export function AssistantIcon({ className, size = 32 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    >
      {/* Monitor body */}
      <rect x="3" y="2" width="26" height="20" fill="#C0C0C0" stroke="#000" strokeWidth="1" />
      {/* Monitor highlight */}
      <line x1="4" y1="3" x2="28" y2="3" stroke="#FFFFFF" strokeWidth="1" />
      <line x1="4" y1="3" x2="4" y2="21" stroke="#FFFFFF" strokeWidth="1" />
      {/* Monitor shadow */}
      <line x1="28" y1="3" x2="28" y2="21" stroke="#808080" strokeWidth="1" />
      <line x1="4" y1="21" x2="28" y2="21" stroke="#808080" strokeWidth="1" />
      {/* Screen */}
      <rect x="5" y="4" width="22" height="14" fill="#000000" stroke="#000" strokeWidth="1" />
      {/* Screen inner border */}
      <rect x="6" y="5" width="20" height="12" fill="#001a00" stroke="none" />
      {/* Terminal text lines (green on black) */}
      <line x1="8" y1="8" x2="16" y2="8" stroke="#00FF00" strokeWidth="1" />
      <line x1="8" y1="11" x2="20" y2="11" stroke="#00FF00" strokeWidth="1" />
      <line x1="8" y1="14" x2="12" y2="14" stroke="#00FF00" strokeWidth="1" />
      {/* Blinking cursor */}
      <rect x="13" y="13" width="2" height="3" fill="#00FF00" />
      {/* Stand neck */}
      <rect x="13" y="22" width="6" height="3" fill="#808080" stroke="#000" strokeWidth="1" />
      {/* Stand base */}
      <rect x="9" y="25" width="14" height="4" fill="#C0C0C0" stroke="#000" strokeWidth="1" />
      {/* Base highlight */}
      <line x1="10" y1="26" x2="22" y2="26" stroke="#FFFFFF" strokeWidth="1" />
      {/* Base shadow */}
      <line x1="10" y1="28" x2="22" y2="28" stroke="#808080" strokeWidth="1" />
    </svg>
  );
}
