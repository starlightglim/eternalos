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

// Resize handle variants
import { CornerLinesResize } from './builtin/resize/CornerLinesResize';
import { CornerDotResize } from './builtin/resize/CornerDotResize';
import { HiddenResize } from './builtin/resize/HiddenResize';

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
}
