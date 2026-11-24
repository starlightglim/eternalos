/**
 * Content an app passes to eternal.fs.write. Text stays text. Binary files
 * (a drawing from canvas.toDataURL, a recorded clip) arrive as a data URL
 * or as base64 with `encoding: 'base64'`. Those used to be stored as the
 * text of an "image" item with no file behind it, so saved media never
 * showed up as a real picture/song/video.
 */
export interface DecodedBinary {
  bytes: Uint8Array;
  /** The MIME type the app declared (the real type is checked separately). */
  declaredMime: string | null;
}

const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?(?:;[a-z0-9-]+=[^;,]*)*;base64,/i;

export function decodeBinaryContent(content: unknown, encoding?: unknown, mimeType?: unknown): DecodedBinary | null {
  if (typeof content !== 'string') return null;
  const dataUrl = DATA_URL_RE.exec(content);
  let base64: string;
  let declaredMime: string | null = typeof mimeType === 'string' && mimeType ? mimeType.toLowerCase() : null;
  if (dataUrl) {
    base64 = content.slice(dataUrl[0].length);
    if (dataUrl[1]) declaredMime = dataUrl[1].toLowerCase();
  } else if (encoding === 'base64') {
    base64 = content;
  } else {
    return null;
  }
  const clean = base64.replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error('File content is not valid base64');
  }
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, declaredMime };
}

/** Desktop item type for a stored binary file. */
export function itemTypeForMime(mime: string): 'image' | 'audio' | 'video' | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}
