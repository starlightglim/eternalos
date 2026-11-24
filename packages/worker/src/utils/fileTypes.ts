/** File types users (and apps, via eternal.fs.write) may store on the desktop. */
export const ALLOWED_TYPES: Record<string, string> = {
  // Images
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  // Text
  'text/plain': 'txt',
  'text/markdown': 'md',
  // Video
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  // Audio
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

/** Max size of one stored file: 10MB. */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
