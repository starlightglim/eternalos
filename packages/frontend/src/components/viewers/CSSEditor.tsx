/**
 * CSSEditor - Custom CSS editor for power users
 *
 * Layer 4 of the customization engine. Allows users to write
 * custom CSS that transforms their desktop. All CSS is scoped
 * to .user-desktop to prevent breaking the app chrome.
 *
 * Features:
 * - Monospace textarea with good editing experience
 * - Live preview with "Apply" button
 * - CSS validation with smart url() allowlist for first-party assets
 * - CSS Reference showing available selectors + data attributes
 * - CSS Asset panel for uploading images to use in url()
 * - Auto-prefixes all rules with .user-desktop
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { listCSSVersions, revertCSSVersion } from '../../services/api';
import type { CustomCSSVersion } from '../../services/api';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useCSSPickerStore } from '../../stores/cssPickerStore';
import { normalizeCSSSelectorAliases } from '../../utils/cssSelectorAliases';
import { CSSAssetPanel } from './CSSAssetPanel';
import styles from './CSSEditor.module.css';

// Maximum CSS size (50KB)
const MAX_CSS_SIZE = 50 * 1024;

// Dangerous patterns that could be used for injection
// Note: url() is NOT blocked here — it's validated separately with an allowlist
const DANGEROUS_PATTERNS = [
  /@import/i,
  /expression\s*\(/i,
  /javascript:/i,
  /behavior\s*:/i,
  /-moz-binding/i,
  /<script/i,
  /<\/script/i,
  // CSS comments (/* ... */) are intentionally allowed — they're a standard
  // part of CSS authoring and don't pose an injection risk on their own.
];

// More specific dangerous patterns for XSS
const XSS_PATTERNS = [
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:/i,
  /expression\s*\(/i,
];

// Allowed url() path prefixes (first-party assets only)
const ALLOWED_URL_PREFIXES = [
  '/api/css-assets/',
  '/api/wallpaper/',
  '/api/icon/',
  '/api/bazaar/assets/',
];

/**
 * Check if a URL value in CSS is allowed
 */
function isAllowedCSSUrl(urlValue: string): boolean {
  return ALLOWED_URL_PREFIXES.some((prefix) => urlValue.startsWith(prefix));
}

interface ValidationResult {
  valid: boolean;
  error?: string;
}

type SaveState = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

/**
 * Validate CSS for dangerous patterns and url() values
 */
function validateCSS(css: string): ValidationResult {
  // Check size
  if (css.length > MAX_CSS_SIZE) {
    return {
      valid: false,
      error: `CSS exceeds maximum size of ${MAX_CSS_SIZE / 1024}KB`,
    };
  }

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(css)) {
      const match = css.match(pattern);
      return {
        valid: false,
        error: `Disallowed pattern detected: "${match?.[0] || pattern.source}"`,
      };
    }
  }

  // Check for XSS patterns
  for (const pattern of XSS_PATTERNS) {
    if (pattern.test(css)) {
      return {
        valid: false,
        error: 'Potentially malicious content detected',
      };
    }
  }

  // Validate url() references — allow only first-party asset paths
  const urlPattern = /url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlPattern.exec(css)) !== null) {
    const urlValue = urlMatch[2];
    if (!isAllowedCSSUrl(urlValue)) {
      return {
        valid: false,
        error: `External url() not allowed: "${urlValue.slice(0, 50)}". Upload images via Assets panel instead.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Scope CSS to .user-desktop
 * Prepends .user-desktop to every selector
 */
function scopeCSS(css: string): string {
  if (!css.trim()) return '';

  const rules = css.split('}');
  const scopedRules: string[] = [];

  for (let rule of rules) {
    rule = rule.trim();
    if (!rule) continue;

    const braceIndex = rule.indexOf('{');
    if (braceIndex === -1) continue;

    const selectors = rule.slice(0, braceIndex).trim();
    const declarations = rule.slice(braceIndex + 1).trim();

    if (selectors.startsWith('@keyframes') || selectors.startsWith('@-webkit-keyframes')) {
      scopedRules.push(`${rule}}`);
      continue;
    }

    if (selectors.startsWith('@media') || selectors.startsWith('@supports')) {
      const atRuleHeader = selectors;
      const innerScoped = scopeCSS(declarations + '}');
      const cleanInner = innerScoped.trim().replace(/}\s*$/, '');
      scopedRules.push(`${atRuleHeader} { ${cleanInner} }}`);
      continue;
    }

    // Skip @font-face
    if (selectors.startsWith('@font-face')) {
      continue;
    }

    const scopedSelectors = selectors
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if (s.startsWith('.user-desktop')) return s;
        if (s === ':root') return '.user-desktop';
        if (s === 'body' || s === 'html') return '.user-desktop';
        return `.user-desktop ${s}`;
      })
      .join(', ');

    scopedRules.push(`${scopedSelectors} { ${declarations} }`);
  }

  return scopedRules.join('\n');
}

// CSS Reference selectors
const CSS_REFERENCE = [
  { selector: '.user-desktop', description: 'The entire desktop area' },
  { selector: '.window', description: 'Window containers' },
  { selector: '[eos-part="titlebar"]', description: 'Window title bars' },
  { selector: '[eos-part="title"]', description: 'Window title text' },
  { selector: '[eos-part="close"]', description: 'Window close button' },
  { selector: '[eos-part="zoom"]', description: 'Window zoom button' },
  { selector: '[eos-part="collapse"]', description: 'Window collapse button' },
  { selector: '[eos-part="content"]', description: 'Window content area' },
  { selector: '[eos-part="icon"]', description: 'File or item icon artwork' },
  { selector: '[eos-part="label"]', description: 'File or item labels' },
  { selector: '.resizeHandle', description: 'Window resize corner' },
  { selector: '.desktopIcon', description: 'Desktop icon containers' },
  { selector: '.menuBar', description: 'The menu bar at top' },
  { selector: '.sticker', description: 'Sticker decorations' },
  { selector: '.folder-view', description: 'Folder window contents' },
  { selector: '.selectionRect', description: 'Drag selection rectangle' },
  // eos- attribute selectors (use Pick Element to find names)
  { selector: '[eos-name="..."]', description: 'Target a specific item by name' },
  { selector: '[eos-type="folder"]', description: 'All folders' },
  { selector: '[eos-type="image"]', description: 'All images' },
  { selector: '[eos-extension="gif"]', description: 'Files with a specific extension (if available)' },
  { selector: '[eos-type="text"]', description: 'All text files' },
  { selector: '[eos-type="link"]', description: 'All links' },
  { selector: '[eos-type="sticker"]', description: 'All stickers' },
  { selector: '[eos-folder="..."]', description: 'All items in a specific folder' },
  // Legacy data attribute selectors
  { selector: '.window[data-content-type="folder"]', description: 'Folder windows' },
  { selector: '.window[data-content-type="image"]', description: 'Image windows' },
  { selector: '.window[data-content-type="text"]', description: 'Text editor windows' },
  { selector: '.window[data-content-type="widget"]', description: 'Widget windows' },
  { selector: '.desktopIcon[data-item-type="folder"]', description: 'Folder icons' },
  { selector: '.desktopIcon[data-item-type="image"]', description: 'Image file icons' },
  { selector: '.desktopIcon[data-item-type="link"]', description: 'Link icons' },
];

// Example CSS snippets
const CSS_EXAMPLES = [
  {
    name: 'Rounded Windows',
    css: `.window {
  border-radius: 8px;
  overflow: hidden;
}`,
  },
  {
    name: 'Glowing Icons',
    css: `.desktopIcon:hover {
  filter: drop-shadow(0 0 8px var(--selection));
}`,
  },
  {
    name: 'Gradient Title Bars',
    css: `.titleBar {
  background: linear-gradient(180deg, #8080FF 0%, #4040CC 100%);
}
.titleText {
  color: white;
  text-shadow: 1px 1px 0 #000;
}`,
  },
  {
    name: 'Pink Folder Windows',
    css: `.window[data-content-type="folder"] .titleBar {
  background: linear-gradient(180deg, #FFB6C1 0%, #FF69B4 100%);
}
.window[data-content-type="folder"] .titleText {
  color: white;
  text-shadow: 1px 1px 0 #CC3366;
}`,
  },
  {
    name: 'CRT Scanlines',
    css: `.user-desktop::after {
  content: '';
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.1) 2px,
    rgba(0, 0, 0, 0.1) 4px
  );
  pointer-events: none;
  z-index: 99999;
}`,
  },
  {
    name: 'Rainbow Icon Labels',
    css: `.desktopIcon[data-item-type="folder"] .iconLabel {
  color: #FF69B4;
}
.desktopIcon[data-item-type="image"] .iconLabel {
  color: #87CEEB;
}
.desktopIcon[data-item-type="text"] .iconLabel {
  color: #98FB98;
}
.desktopIcon[data-item-type="link"] .iconLabel {
  color: #DDA0DD;
}`,
  },
  {
    name: 'Custom Cursor',
    css: `/* Upload a cursor image via Assets, then paste its url() here */
.user-desktop {
  cursor: url(/api/css-assets/YOUR_UID/ASSET_ID/cursor.png) 0 0, auto;
}`,
  },
  {
    name: 'Floating Sticker',
    css: `/* Upload a sticker image via Assets, then paste its url() here */
.user-desktop::before {
  content: '';
  position: fixed;
  top: 40px;
  right: 20px;
  width: 80px;
  height: 80px;
  background-image: url(/api/css-assets/YOUR_UID/ASSET_ID/sticker.png);
  background-size: contain;
  background-repeat: no-repeat;
  pointer-events: none;
  z-index: 99998;
}`,
  },
  {
    name: 'Style One Item',
    css: `/* Use "Pick Element" to find the name of your item */
[eos-name="my-item"] {
  filter: drop-shadow(0 0 8px gold);
  transform: scale(1.1);
}`,
  },
  {
    name: '✿ Y2K Kawaii',
    css: `/* ✿ Y2K Kawaii Desktop ✿ */

/* Rounded, soft windows */
.window {
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 2px 2px 10px rgba(0,0,0,0.15), 0 0 20px rgba(255,182,193,0.2);
}

/* Pink folder windows */
.window[data-content-type="folder"] .titleBar {
  background: linear-gradient(180deg, #FFB6C1 0%, #FF69B4 100%);
}
.window[data-content-type="folder"] .titleText {
  color: white;
  text-shadow: 1px 1px 0 #CC3366;
}

/* Mint green text windows */
.window[data-content-type="text"] .titleBar {
  background: linear-gradient(180deg, #98FB98 0%, #3CB371 100%);
}
.window[data-content-type="text"] .titleText {
  color: white;
  text-shadow: 1px 1px 0 #2E8B57;
}

/* Lavender image windows */
.window[data-content-type="image"] .titleBar {
  background: linear-gradient(180deg, #E6E6FA 0%, #9370DB 100%);
}
.window[data-content-type="image"] .titleText {
  color: white;
  text-shadow: 1px 1px 0 #6A5ACD;
}

/* Baby blue widget windows */
.window[data-content-type="widget"] .titleBar {
  background: linear-gradient(180deg, #87CEEB 0%, #4682B4 100%);
}
.window[data-content-type="widget"] .titleText {
  color: white;
  text-shadow: 1px 1px 0 #2C5F8A;
}

/* Rainbow icon labels */
.desktopIcon[data-item-type="folder"] .iconLabel {
  color: #FF69B4;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
.desktopIcon[data-item-type="image"] .iconLabel {
  color: #87CEEB;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
.desktopIcon[data-item-type="text"] .iconLabel {
  color: #98FB98;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
.desktopIcon[data-item-type="link"] .iconLabel {
  color: #DDA0DD;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}

/* Sparkle hover on icons */
.desktopIcon:hover {
  filter: drop-shadow(0 0 6px #FF69B4) drop-shadow(0 0 12px #FFB6C1);
  transform: scale(1.05);
  transition: all 0.15s ease;
}

/* Floating hearts decoration */
.user-desktop::before {
  content: '\\2661 \\2727 \\2661 \\2727 \\2661';
  position: fixed;
  top: 28px;
  right: 16px;
  font-size: 16px;
  color: rgba(255,105,180,0.5);
  letter-spacing: 8px;
  pointer-events: none;
  z-index: 99998;
  animation: floatHearts 3s ease-in-out infinite;
}

@keyframes floatHearts {
  0%, 100% { transform: translateY(0); opacity: 0.5; }
  50% { transform: translateY(-6px); opacity: 0.8; }
}

/* Starfield bottom corner */
.user-desktop::after {
  content: '\\2726 \\22C6 \\2727 \\22C6 \\2726';
  position: fixed;
  bottom: 36px;
  left: 16px;
  font-size: 14px;
  color: rgba(147,112,219,0.4);
  letter-spacing: 6px;
  pointer-events: none;
  z-index: 99998;
  animation: twinkle 2s ease-in-out infinite alternate;
}

@keyframes twinkle {
  0% { opacity: 0.3; transform: scale(1); }
  100% { opacity: 0.7; transform: scale(1.1); }
}

/* Soft selection rectangle */
.selectionRect {
  border: 2px solid #FF69B4 !important;
  background: rgba(255,105,180,0.1) !important;
  border-radius: 4px;
}`,
  },
];

export function CSSEditor() {
  const {
    appearance,
    customCSSPreview,
    customCSSPreviewSummary,
    setCustomCSS,
    saveAppearance,
    clearCustomCSSPreview,
    isLoading,
  } = useAppearanceStore();
  const { isActive: pickerActive, activate: activatePicker, deactivate: deactivatePicker } = useCSSPickerStore();
  const [cssDraft, setCssDraft] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showReference, setShowReference] = useState(false);
  const [showAssets, setShowAssets] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [history, setHistory] = useState<CustomCSSVersion[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewStyleRef = useRef<HTMLStyleElement | null>(null);
  const saveStateTimerRef = useRef<number | null>(null);
  const cssInput = cssDraft ?? customCSSPreview ?? appearance.customCSS ?? '';

  // Cleanup preview style on unmount
  useEffect(() => {
    return () => {
      if (previewStyleRef.current) {
        previewStyleRef.current.remove();
      }
      if (saveStateTimerRef.current !== null) {
        window.clearTimeout(saveStateTimerRef.current);
      }
    };
  }, []);

  const loadHistory = useCallback(async () => {
    setIsHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistory(await listCSSVersions());
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Failed to load custom CSS history');
    } finally {
      setIsHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (showHistory) {
      void loadHistory();
    }
  }, [loadHistory, showHistory]);

  const setEditorDirty = useCallback(() => {
    if (saveStateTimerRef.current !== null) {
      window.clearTimeout(saveStateTimerRef.current);
      saveStateTimerRef.current = null;
    }
    setHasUnsavedChanges(true);
    setSaveState('unsaved');
    setSaveError(null);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setCssDraft(value);
    setEditorDirty();

    // Validate on change
    const result = validateCSS(value);
    setValidationError(result.valid ? null : result.error || 'Invalid CSS');

    // Remove preview when editing
    if (previewActive) {
      setPreviewActive(false);
      if (previewStyleRef.current) {
        previewStyleRef.current.remove();
        previewStyleRef.current = null;
      }
    }
  }, [previewActive, setEditorDirty]);

  const handlePreview = useCallback(() => {
    const result = validateCSS(cssInput);
    if (!result.valid) {
      setValidationError(result.error || 'Invalid CSS');
      return;
    }

    const scopedCSS = scopeCSS(normalizeCSSSelectorAliases(cssInput));

    if (previewStyleRef.current) {
      previewStyleRef.current.remove();
    }

    const style = document.createElement('style');
    style.setAttribute('data-custom-css-preview', 'true');
    style.textContent = scopedCSS;
    document.head.appendChild(style);
    previewStyleRef.current = style;
    setPreviewActive(true);
  }, [cssInput]);

  const handleApply = useCallback(async () => {
    const result = validateCSS(cssInput);
    if (!result.valid) {
      setValidationError(result.error || 'Invalid CSS');
      return;
    }

    if (previewStyleRef.current) {
      previewStyleRef.current.remove();
      previewStyleRef.current = null;
    }

    const normalizedCSS = normalizeCSSSelectorAliases(cssInput);

    setSaveState('saving');
    setSaveError(null);
    setCustomCSS(normalizedCSS);
    try {
      await saveAppearance();
      await loadHistory();
      clearCustomCSSPreview();
      setCssDraft(null);
      setHasUnsavedChanges(false);
      setPreviewActive(false);
      setSaveState('saved');

      if (saveStateTimerRef.current !== null) {
        window.clearTimeout(saveStateTimerRef.current);
      }
      saveStateTimerRef.current = window.setTimeout(() => {
        setSaveState('idle');
        saveStateTimerRef.current = null;
      }, 2500);
    } catch (error) {
      setSaveState('error');
      setSaveError(error instanceof Error ? error.message : 'Failed to save custom CSS');
    }
  }, [clearCustomCSSPreview, cssInput, loadHistory, saveAppearance, setCustomCSS]);

  const handleReset = useCallback(() => {
    setCssDraft('');
    setValidationError(null);
    setEditorDirty();
    setPreviewActive(false);

    if (previewStyleRef.current) {
      previewStyleRef.current.remove();
      previewStyleRef.current = null;
    }
  }, [setEditorDirty]);

  const handleInsertExample = useCallback((css: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = cssInput.slice(0, start);
    const after = cssInput.slice(end);
    const newCSS = before + (before && !before.endsWith('\n') ? '\n\n' : '') + css + after;

    setCssDraft(newCSS);
    setEditorDirty();

    setTimeout(() => {
      textarea.focus();
      const newPos = start + css.length + (before && !before.endsWith('\n') ? 2 : 0);
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  }, [cssInput, setEditorDirty]);

  const handleInsertAssetUrl = useCallback((urlPath: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const snippet = `url(${urlPath})`;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = cssInput.slice(0, start);
    const after = cssInput.slice(end);
    const newCSS = before + snippet + after;

    setCssDraft(newCSS);
    setEditorDirty();

    setTimeout(() => {
      textarea.focus();
      const newPos = start + snippet.length;
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  }, [cssInput, setEditorDirty]);

  // Handle selector chosen from picker — insert CSS rule block at cursor
  const handleSelectorChosen = useCallback((selector: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const ruleBlock = `${selector} {\n  \n}`;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = cssInput.slice(0, start);
    const after = cssInput.slice(end);
    const newCSS = before + (before && !before.endsWith('\n') ? '\n\n' : '') + ruleBlock + after;

    setCssDraft(newCSS);
    setEditorDirty();

    // Position cursor inside the rule block (on the empty line)
    setTimeout(() => {
      textarea.focus();
      const cursorOffset = (before && !before.endsWith('\n') ? 2 : 0);
      const newPos = start + cursorOffset + selector.length + 4; // after "selector {\n  "
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  }, [cssInput, setEditorDirty]);

  // Toggle picker
  const handleTogglePicker = useCallback(() => {
    if (pickerActive) {
      deactivatePicker();
    } else {
      setShowReference(false);
      setShowAssets(false);
      activatePicker(handleSelectorChosen);
    }
  }, [pickerActive, activatePicker, deactivatePicker, handleSelectorChosen]);

  const handleRestoreVersion = useCallback(async (versionId: string) => {
    setRestoringVersionId(versionId);
    setSaveState('saving');
    setSaveError(null);
    setHistoryError(null);

    if (previewStyleRef.current) {
      previewStyleRef.current.remove();
      previewStyleRef.current = null;
    }

    try {
      const response = await revertCSSVersion(versionId);
      if (!response.profile) {
        throw new Error('Profile response missing after restore');
      }

      useAppearanceStore.getState().loadAppearance({
        accentColor: response.profile.accentColor,
        desktopColor: response.profile.desktopColor,
        windowBgColor: response.profile.windowBgColor,
        titleBarBgColor: response.profile.titleBarBgColor,
        titleBarTextColor: response.profile.titleBarTextColor,
        windowBorderColor: response.profile.windowBorderColor,
        buttonBgColor: response.profile.buttonBgColor,
        buttonTextColor: response.profile.buttonTextColor,
        buttonBorderColor: response.profile.buttonBorderColor,
        labelColor: response.profile.labelColor,
        fontSmoothing: response.profile.fontSmoothing,
        windowBorderRadius: response.profile.windowBorderRadius,
        controlBorderRadius: response.profile.controlBorderRadius,
        windowShadow: response.profile.windowShadow,
        customCSS: response.profile.customCSS,
      });

      setCssDraft(null);
      setValidationError(null);
      setPreviewActive(false);
      setHasUnsavedChanges(false);
      clearCustomCSSPreview();
      setSaveState('saved');

      if (response.versions) {
        setHistory(response.versions);
      } else {
        await loadHistory();
      }

      if (saveStateTimerRef.current !== null) {
        window.clearTimeout(saveStateTimerRef.current);
      }
      saveStateTimerRef.current = window.setTimeout(() => {
        setSaveState('idle');
        saveStateTimerRef.current = null;
      }, 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restore custom CSS version';
      setSaveState('error');
      setSaveError(message);
      setHistoryError(message);
    } finally {
      setRestoringVersionId(null);
    }
  }, [clearCustomCSSPreview, loadHistory]);

  // Deactivate picker on unmount
  useEffect(() => {
    return () => {
      deactivatePicker();
    };
  }, [deactivatePicker]);

  const charCount = cssInput.length;
  const charLimit = MAX_CSS_SIZE;
  const charPercent = Math.round((charCount / charLimit) * 100);
  const statusText =
    saveState === 'saving'
      ? 'Saving custom CSS...'
      : saveState === 'saved'
        ? 'Custom CSS saved'
        : saveState === 'error'
          ? saveError || 'Failed to save custom CSS'
          : saveState === 'unsaved'
            ? 'Unsaved changes'
            : 'Ready';

  return (
    <div className={styles.editor}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolButtons}>
          <button
            className={`${styles.toolButton} ${pickerActive ? styles.toolButtonActive : ''}`}
            onClick={handleTogglePicker}
            title="Pick an element on the desktop to target with CSS"
          >
            &#x271B; Pick Element
          </button>
          <button
            className={`${styles.toolButton} ${showReference ? styles.toolButtonActive : ''}`}
            onClick={() => {
              setShowReference(!showReference);
              if (!showReference) {
                setShowAssets(false);
                setShowHistory(false);
              }
            }}
            title="CSS Reference"
          >
            Reference
          </button>
          <button
            className={`${styles.toolButton} ${showAssets ? styles.toolButtonActive : ''}`}
            onClick={() => {
              setShowAssets(!showAssets);
              if (!showAssets) {
                setShowReference(false);
                setShowHistory(false);
              }
            }}
            title="Upload and manage CSS image assets"
          >
            Assets
          </button>
          <button
            className={`${styles.toolButton} ${showHistory ? styles.toolButtonActive : ''}`}
            onClick={() => {
              setShowHistory(!showHistory);
              if (!showHistory) {
                setShowReference(false);
                setShowAssets(false);
              }
            }}
            title="Saved custom CSS history"
          >
            History
          </button>
        </div>
        <div className={styles.charCount} data-warning={charPercent > 80}>
          {charCount.toLocaleString()} / {(charLimit / 1024).toFixed(0)}KB
        </div>
      </div>

      {/* Reference panel */}
      {showReference && (
        <div className={styles.referencePanel}>
          <div className={styles.referenceSection}>
            <h4>Available Selectors</h4>
            <div className={styles.selectorList}>
              {CSS_REFERENCE.map((ref) => (
                <div key={ref.selector} className={styles.selectorItem}>
                  <code>{ref.selector}</code>
                  <span>{ref.description}</span>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.referenceSection}>
            <h4>Examples</h4>
            <div className={styles.exampleList}>
              {CSS_EXAMPLES.map((ex) => (
                <button
                  key={ex.name}
                  className={styles.exampleButton}
                  onClick={() => handleInsertExample(ex.css)}
                  title="Click to insert"
                >
                  {ex.name}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.referenceNote}>
            <strong>Note:</strong> All CSS is scoped to <code>.user-desktop</code>.
            Use <code>url()</code> with uploaded CSS assets (click &quot;Assets&quot;
            above). External URLs and @import are blocked.
          </div>
        </div>
      )}

      {/* Asset panel */}
      {showAssets && (
        <CSSAssetPanel onInsertUrl={handleInsertAssetUrl} />
      )}

      {showHistory && (
        <div className={styles.referencePanel}>
          <div className={styles.referenceSection}>
            <h4>Saved Versions</h4>
            {isHistoryLoading && <div className={styles.historyMeta}>Loading history...</div>}
            {!isHistoryLoading && historyError && <div className={styles.historyError}>{historyError}</div>}
            {!isHistoryLoading && !historyError && history.length === 0 && (
              <div className={styles.historyMeta}>No saved custom CSS versions yet.</div>
            )}
            {!isHistoryLoading && !historyError && history.length > 0 && (
              <div className={styles.historyList}>
                {history.map((version, index) => (
                  <div key={version.id} className={styles.historyItem}>
                    <div className={styles.historyInfo}>
                      <div className={styles.historyTitle}>
                        {version.summary || `Version ${history.length - index}`}
                      </div>
                      <div className={styles.historyMeta}>
                        {new Date(version.createdAt).toLocaleString()} · {version.source}
                      </div>
                    </div>
                    <button
                      className={styles.historyButton}
                      onClick={() => void handleRestoreVersion(version.id)}
                      disabled={restoringVersionId === version.id}
                    >
                      {restoringVersionId === version.id ? 'Restoring...' : 'Restore'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Editor area */}
      <div className={styles.editorArea}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={cssInput}
          onChange={handleInputChange}
          placeholder={`/* Write your custom CSS here */

/* Target specific window types: */
.window[data-content-type="folder"] .titleBar {
  background: linear-gradient(#FFB6C1, #FF69B4);
}

/* Upload images via Assets to use in url(): */
.user-desktop::before {
  content: '';
  background-image: url(/api/css-assets/...);
}`}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>

      {/* Validation error */}
      {validationError && (
        <div className={styles.errorBar}>
          <span className={styles.errorIcon}>⚠</span>
          {validationError}
        </div>
      )}

      {/* Preview indicator */}
      {(previewActive || !!customCSSPreview) && (
        <div className={styles.previewBar}>
          <span className={styles.previewIcon}>👁</span>
          {customCSSPreview
            ? customCSSPreviewSummary || 'Assistant preview active — changes not saved yet'
            : 'Preview active — changes not saved yet'}
        </div>
      )}

      {/* Action bar */}
      <div className={styles.actionBar}>
        <div className={styles.actionLeft}>
          <button
            className={styles.resetButton}
            onClick={handleReset}
            disabled={isLoading || !cssInput}
          >
            Clear All
          </button>
          <span
            className={`${styles.saveState} ${
              saveState === 'saving'
                ? styles.saveStateSaving
                : saveState === 'saved'
                  ? styles.saveStateSaved
                  : saveState === 'error'
                    ? styles.saveStateError
                    : saveState === 'unsaved'
                      ? styles.saveStateUnsaved
                      : ''
            }`}
          >
            {statusText}
          </span>
        </div>
        <div className={styles.actionButtons}>
          <button
            className={styles.previewButton}
            onClick={handlePreview}
            disabled={isLoading || !cssInput || !!validationError}
          >
            Preview
          </button>
          <button
            className={styles.applyButton}
            onClick={handleApply}
            disabled={isLoading || !!validationError || !hasUnsavedChanges}
          >
            {saveState === 'saving' || isLoading ? 'Saving...' : 'Apply & Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
