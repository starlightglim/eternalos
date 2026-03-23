/**
 * Register all built-in variants.
 * Idempotent — safe to call multiple times.
 */

import { variantRegistry } from './registry';

let registered = false;

// Chrome variants
import { BeveledChrome } from './builtin/chrome/BeveledChrome';
import { FlatChrome } from './builtin/chrome/FlatChrome';
import { FloatingChrome } from './builtin/chrome/FloatingChrome';

// Title bar variants
import { ClassicTitleBar } from './builtin/titlebar/ClassicTitleBar';
import { FlatTitleBar } from './builtin/titlebar/FlatTitleBar';
import { GradientTitleBar } from './builtin/titlebar/GradientTitleBar';

// Button variants
import { SquareButtons } from './builtin/buttons/SquareButtons';
import { CircleButtons } from './builtin/buttons/CircleButtons';
import { TextButtons } from './builtin/buttons/TextButtons';
import { HiddenButtons } from './builtin/buttons/HiddenButtons';
import { SpriteButtons } from './builtin/buttons/SpriteButtons';

// Resize handle variants
import { CornerLinesResize } from './builtin/resize/CornerLinesResize';
import { CornerDotResize } from './builtin/resize/CornerDotResize';
import { HiddenResize } from './builtin/resize/HiddenResize';
import { SpriteResize } from './builtin/resize/SpriteResize';

export function registerBuiltinVariants() {
  if (registered) return;
  registered = true;

  // --- Window Chrome ---
  variantRegistry.register({
    id: 'beveled',
    slotId: 'window.chrome',
    label: 'Beveled',
    description: 'Classic Mac OS 3D beveled frame',
    component: BeveledChrome,
  });
  variantRegistry.register({
    id: 'flat',
    slotId: 'window.chrome',
    label: 'Flat',
    description: 'Clean flat border, no bevel effect',
    component: FlatChrome,
  });
  variantRegistry.register({
    id: 'floating',
    slotId: 'window.chrome',
    label: 'Floating',
    description: 'No border, shadow only',
    component: FloatingChrome,
  });

  // --- Title Bar ---
  variantRegistry.register({
    id: 'classic',
    slotId: 'window.titleBar',
    label: 'Classic',
    description: 'Mac OS 8 striped title bar',
    component: ClassicTitleBar,
  });
  variantRegistry.register({
    id: 'flat',
    slotId: 'window.titleBar',
    label: 'Flat',
    description: 'Solid color, no stripes',
    component: FlatTitleBar,
  });
  variantRegistry.register({
    id: 'gradient',
    slotId: 'window.titleBar',
    label: 'Gradient',
    description: 'Two-color gradient title bar',
    component: GradientTitleBar,
    tokens: [
      {
        path: 'window.titleBar.gradientStart',
        profileKey: null,
        label: 'Gradient Start',
        hint: 'Top color of the title bar gradient',
        tab: 'windows',
        group: 'Title Bar Gradient',
        valueType: 'cssColor',
        defaultValue: '#4080C0',
        cssVars: ['--eos-titlebar-gradient-start'],
        condition: { slotId: 'window.titleBar', variantId: 'gradient' },
      },
      {
        path: 'window.titleBar.gradientEnd',
        profileKey: null,
        label: 'Gradient End',
        hint: 'Bottom color of the title bar gradient',
        tab: 'windows',
        group: 'Title Bar Gradient',
        valueType: 'cssColor',
        defaultValue: '#1A3050',
        cssVars: ['--eos-titlebar-gradient-end'],
        condition: { slotId: 'window.titleBar', variantId: 'gradient' },
      },
    ],
    defaults: {
      'window.titleBar.gradientStart': '#4080C0',
      'window.titleBar.gradientEnd': '#1A3050',
    },
  });

  // --- Window Buttons ---
  variantRegistry.register({
    id: 'square',
    slotId: 'window.buttons',
    label: 'Square',
    description: 'Classic Mac OS square buttons',
    component: SquareButtons,
  });
  variantRegistry.register({
    id: 'circle',
    slotId: 'window.buttons',
    label: 'Circle',
    description: 'macOS-style traffic light circles',
    component: CircleButtons,
  });
  variantRegistry.register({
    id: 'text',
    slotId: 'window.buttons',
    label: 'Text',
    description: 'Unicode text characters (x - [])',
    component: TextButtons,
  });
  variantRegistry.register({
    id: 'hidden',
    slotId: 'window.buttons',
    label: 'Hidden',
    description: 'No visible buttons (hover to reveal)',
    component: HiddenButtons,
  });

  // --- Resize Handle ---
  variantRegistry.register({
    id: 'lines',
    slotId: 'window.resizeHandle',
    label: 'Lines',
    description: 'Classic diagonal lines grip',
    component: CornerLinesResize,
  });
  variantRegistry.register({
    id: 'dot',
    slotId: 'window.resizeHandle',
    label: 'Dot',
    description: 'Single dot indicator',
    component: CornerDotResize,
  });
  variantRegistry.register({
    id: 'hidden',
    slotId: 'window.resizeHandle',
    label: 'Hidden',
    description: 'Invisible, cursor-only resize',
    component: HiddenResize,
  });

  // --- Sprite Variants (Skin system) ---
  // Chrome and TitleBar sprite variants use the unified wrapper CSS classes,
  // so we register BeveledChrome/ClassicTitleBar as placeholder components.
  // The actual sprite rendering is driven by CSS variables + border-image/background-image.

  variantRegistry.register({
    id: 'sprite',
    slotId: 'window.chrome',
    label: 'Sprite',
    description: 'Custom 9-slice frame image (Winamp-style)',
    component: BeveledChrome, // Unified WindowChrome handles CSS class switching
    tokens: [
      {
        path: 'chrome.sprite.url',
        profileKey: null,
        label: 'Frame Image',
        hint: 'Upload a PNG for the window frame (9-slice stretched)',
        tab: 'windows',
        group: 'Sprite Frame',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-chrome-sprite-url'],
        condition: { slotId: 'window.chrome' as const, variantId: 'sprite' },
      },
      {
        path: 'chrome.sprite.sliceTop',
        profileKey: null,
        label: 'Slice Top',
        hint: 'Pixels from top edge to keep fixed',
        tab: 'windows',
        group: 'Sprite Frame',
        valueType: 'number' as const,
        defaultValue: 20,
        numberConstraints: { min: 0, max: 100, unit: 'px' as const },
        condition: { slotId: 'window.chrome' as const, variantId: 'sprite' },
      },
      {
        path: 'chrome.sprite.sliceRight',
        profileKey: null,
        label: 'Slice Right',
        hint: 'Pixels from right edge to keep fixed',
        tab: 'windows',
        group: 'Sprite Frame',
        valueType: 'number' as const,
        defaultValue: 20,
        numberConstraints: { min: 0, max: 100, unit: 'px' as const },
        condition: { slotId: 'window.chrome' as const, variantId: 'sprite' },
      },
      {
        path: 'chrome.sprite.sliceBottom',
        profileKey: null,
        label: 'Slice Bottom',
        hint: 'Pixels from bottom edge to keep fixed',
        tab: 'windows',
        group: 'Sprite Frame',
        valueType: 'number' as const,
        defaultValue: 20,
        numberConstraints: { min: 0, max: 100, unit: 'px' as const },
        condition: { slotId: 'window.chrome' as const, variantId: 'sprite' },
      },
      {
        path: 'chrome.sprite.sliceLeft',
        profileKey: null,
        label: 'Slice Left',
        hint: 'Pixels from left edge to keep fixed',
        tab: 'windows',
        group: 'Sprite Frame',
        valueType: 'number' as const,
        defaultValue: 20,
        numberConstraints: { min: 0, max: 100, unit: 'px' as const },
        condition: { slotId: 'window.chrome' as const, variantId: 'sprite' },
      },
    ],
    defaults: {
      'chrome.sprite.sliceTop': 20,
      'chrome.sprite.sliceRight': 20,
      'chrome.sprite.sliceBottom': 20,
      'chrome.sprite.sliceLeft': 20,
    },
  });

  variantRegistry.register({
    id: 'sprite',
    slotId: 'window.titleBar',
    label: 'Sprite',
    description: 'Custom title bar texture image',
    component: ClassicTitleBar, // Unified WindowTitleBar handles CSS class switching
    tokens: [
      {
        path: 'titlebar.sprite.url',
        profileKey: null,
        label: 'Title Bar Image',
        hint: 'Upload a texture for the title bar background',
        tab: 'windows',
        group: 'Sprite Title Bar',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-titlebar-sprite-url'],
        condition: { slotId: 'window.titleBar' as const, variantId: 'sprite' },
      },
      {
        path: 'titlebar.sprite.textColor',
        profileKey: null,
        label: 'Title Text Color',
        hint: 'Text color over the sprite title bar',
        tab: 'windows',
        group: 'Sprite Title Bar',
        valueType: 'color' as const,
        defaultValue: '#FFFFFF',
        cssVars: ['--eos-titlebar-sprite-text-color'],
        condition: { slotId: 'window.titleBar' as const, variantId: 'sprite' },
      },
    ],
    defaults: {
      'titlebar.sprite.textColor': '#FFFFFF',
    },
  });

  variantRegistry.register({
    id: 'sprite',
    slotId: 'window.buttons',
    label: 'Sprite',
    description: 'Custom image buttons (upload per-button sprites)',
    component: SpriteButtons,
    tokens: [
      {
        path: 'buttons.sprite.close',
        profileKey: null,
        label: 'Close Button',
        hint: 'Image for the close button',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-sprite-btn-close'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
      {
        path: 'buttons.sprite.closeHover',
        profileKey: null,
        label: 'Close (Hover)',
        hint: 'Image for close button hover state',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-sprite-btn-close-hover'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
      {
        path: 'buttons.sprite.closeActive',
        profileKey: null,
        label: 'Close (Active)',
        hint: 'Image for close button pressed state',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-sprite-btn-close-active'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
      {
        path: 'buttons.sprite.zoom',
        profileKey: null,
        label: 'Zoom Button',
        hint: 'Image for the zoom/maximize button',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-sprite-btn-zoom'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
      {
        path: 'buttons.sprite.zoomHover',
        profileKey: null,
        label: 'Zoom (Hover)',
        hint: 'Image for zoom button hover state',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-sprite-btn-zoom-hover'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
      {
        path: 'buttons.sprite.zoomActive',
        profileKey: null,
        label: 'Zoom (Active)',
        hint: 'Image for zoom button pressed state',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-sprite-btn-zoom-active'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
      {
        path: 'buttons.sprite.collapse',
        profileKey: null,
        label: 'Collapse Button',
        hint: 'Image for the collapse/minimize button',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-sprite-btn-collapse'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
      {
        path: 'buttons.sprite.collapseHover',
        profileKey: null,
        label: 'Collapse (Hover)',
        hint: 'Image for collapse button hover state',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-sprite-btn-collapse-hover'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
      {
        path: 'buttons.sprite.collapseActive',
        profileKey: null,
        label: 'Collapse (Active)',
        hint: 'Image for collapse button pressed state',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-sprite-btn-collapse-active'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
      {
        path: 'buttons.sprite.width',
        profileKey: null,
        label: 'Button Width',
        hint: 'Width of each button in pixels',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'number' as const,
        defaultValue: 16,
        numberConstraints: { min: 8, max: 48, unit: 'px' as const },
        cssVars: ['--eos-sprite-button-width'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
      {
        path: 'buttons.sprite.height',
        profileKey: null,
        label: 'Button Height',
        hint: 'Height of each button in pixels',
        tab: 'windows',
        group: 'Sprite Buttons',
        valueType: 'number' as const,
        defaultValue: 16,
        numberConstraints: { min: 8, max: 48, unit: 'px' as const },
        cssVars: ['--eos-sprite-button-height'],
        condition: { slotId: 'window.buttons' as const, variantId: 'sprite' },
      },
    ],
    defaults: {
      'buttons.sprite.width': 16,
      'buttons.sprite.height': 16,
    },
  });

  variantRegistry.register({
    id: 'sprite',
    slotId: 'window.resizeHandle',
    label: 'Sprite',
    description: 'Custom resize handle image',
    component: SpriteResize,
    tokens: [
      {
        path: 'resize.sprite.url',
        profileKey: null,
        label: 'Resize Handle Image',
        hint: 'Upload an image for the resize grip',
        tab: 'windows',
        group: 'Sprite Resize',
        valueType: 'cssText' as const,
        defaultValue: '',
        cssVars: ['--eos-sprite-resize-url'],
        condition: { slotId: 'window.resizeHandle' as const, variantId: 'sprite' },
      },
    ],
  });
}
