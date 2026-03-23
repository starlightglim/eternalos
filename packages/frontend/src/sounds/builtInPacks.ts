/**
 * Built-in Sound Packs for EternalOS
 *
 * Each pack defines synthesis parameters for every sound type.
 * All sounds are generated using the Web Audio API — no external files needed.
 *
 * Packs:
 *   - classic: Original Mac OS beeps (current default)
 *   - scifi: Futuristic tones with layered sine waves
 *   - typewriter: Mechanical, clicky sounds
 */

export type BuiltInPackId = 'classic' | 'scifi' | 'typewriter';

export type SynthSoundType =
  | 'click' | 'windowOpen' | 'windowClose' | 'folderOpen'
  | 'drop' | 'trash' | 'emptyTrash' | 'alert' | 'error'
  | 'startup' | 'select';

interface ToneStep {
  frequency: number;
  duration: number;
  type: OscillatorType;
  delay?: number; // ms delay before this step
  volume?: number; // 0-1, relative to master volume
}

export interface SoundDefinition {
  steps: ToneStep[];
}

export type PackDefinition = Record<SynthSoundType, SoundDefinition>;

// ---------------------------------------------------------------------------
// Classic Pack — faithful Mac OS beeps (matches current soundStore behavior)
// ---------------------------------------------------------------------------
const classic: PackDefinition = {
  click:       { steps: [{ frequency: 1000, duration: 0.02, type: 'square' }] },
  windowOpen:  { steps: [
    { frequency: 400, duration: 0.05, type: 'sine' },
    { frequency: 600, duration: 0.05, type: 'sine', delay: 30 },
  ]},
  windowClose: { steps: [
    { frequency: 600, duration: 0.05, type: 'sine' },
    { frequency: 400, duration: 0.05, type: 'sine', delay: 30 },
  ]},
  folderOpen:  { steps: [{ frequency: 800, duration: 0.03, type: 'triangle' }] },
  drop:        { steps: [{ frequency: 150, duration: 0.08, type: 'sine' }] },
  trash:       { steps: [
    { frequency: 300, duration: 0.04, type: 'sawtooth' },
    { frequency: 200, duration: 0.06, type: 'sawtooth', delay: 40 },
  ]},
  emptyTrash:  { steps: Array.from({ length: 5 }, (_, i) => ({
    frequency: 400 - i * 60,
    duration: 0.04,
    type: 'sawtooth' as OscillatorType,
    delay: i * 40,
    volume: 1 - i * 0.15,
  }))},
  alert:       { steps: [
    { frequency: 880, duration: 0.1, type: 'sine' },
    { frequency: 880, duration: 0.1, type: 'sine', delay: 150 },
  ]},
  error:       { steps: [{ frequency: 220, duration: 0.2, type: 'sine' }] },
  startup:     { steps: [
    { frequency: 523, duration: 0.15, type: 'sine' },
    { frequency: 659, duration: 0.15, type: 'sine', delay: 120 },
    { frequency: 784, duration: 0.2, type: 'sine', delay: 240 },
  ]},
  select:      { steps: [{ frequency: 900, duration: 0.015, type: 'square' }] },
};

// ---------------------------------------------------------------------------
// Sci-Fi Pack — futuristic, spacey tones
// ---------------------------------------------------------------------------
const scifi: PackDefinition = {
  click:       { steps: [
    { frequency: 2400, duration: 0.015, type: 'sine' },
    { frequency: 1200, duration: 0.015, type: 'sine', delay: 10 },
  ]},
  windowOpen:  { steps: [
    { frequency: 200, duration: 0.08, type: 'sine' },
    { frequency: 400, duration: 0.06, type: 'sine', delay: 40 },
    { frequency: 800, duration: 0.04, type: 'sine', delay: 80 },
  ]},
  windowClose: { steps: [
    { frequency: 800, duration: 0.04, type: 'sine' },
    { frequency: 400, duration: 0.06, type: 'sine', delay: 40 },
    { frequency: 200, duration: 0.08, type: 'sine', delay: 80 },
  ]},
  folderOpen:  { steps: [
    { frequency: 600, duration: 0.03, type: 'sine' },
    { frequency: 1200, duration: 0.02, type: 'sine', delay: 20 },
  ]},
  drop:        { steps: [
    { frequency: 300, duration: 0.06, type: 'sine' },
    { frequency: 100, duration: 0.1, type: 'sine', delay: 30 },
  ]},
  trash:       { steps: [
    { frequency: 500, duration: 0.03, type: 'sine' },
    { frequency: 250, duration: 0.05, type: 'sine', delay: 30 },
    { frequency: 125, duration: 0.08, type: 'sine', delay: 60 },
  ]},
  emptyTrash:  { steps: Array.from({ length: 6 }, (_, i) => ({
    frequency: 800 - i * 120,
    duration: 0.03,
    type: 'sine' as OscillatorType,
    delay: i * 35,
    volume: 1 - i * 0.12,
  }))},
  alert:       { steps: [
    { frequency: 1200, duration: 0.08, type: 'sine' },
    { frequency: 1500, duration: 0.08, type: 'sine', delay: 100 },
    { frequency: 1200, duration: 0.08, type: 'sine', delay: 200 },
  ]},
  error:       { steps: [
    { frequency: 150, duration: 0.15, type: 'sine' },
    { frequency: 100, duration: 0.2, type: 'sine', delay: 100 },
  ]},
  startup:     { steps: [
    { frequency: 220, duration: 0.2, type: 'sine' },
    { frequency: 440, duration: 0.15, type: 'sine', delay: 150 },
    { frequency: 660, duration: 0.15, type: 'sine', delay: 300 },
    { frequency: 880, duration: 0.25, type: 'sine', delay: 450 },
  ]},
  select:      { steps: [{ frequency: 1800, duration: 0.01, type: 'sine' }] },
};

// ---------------------------------------------------------------------------
// Typewriter Pack — mechanical, clicky, warm
// ---------------------------------------------------------------------------
const typewriter: PackDefinition = {
  click:       { steps: [
    { frequency: 600, duration: 0.008, type: 'sawtooth' },
    { frequency: 200, duration: 0.01, type: 'square', delay: 5 },
  ]},
  windowOpen:  { steps: [
    { frequency: 300, duration: 0.02, type: 'square' },
    { frequency: 500, duration: 0.02, type: 'square', delay: 25 },
    { frequency: 400, duration: 0.03, type: 'square', delay: 50 },
  ]},
  windowClose: { steps: [
    { frequency: 500, duration: 0.02, type: 'square' },
    { frequency: 300, duration: 0.02, type: 'square', delay: 25 },
    { frequency: 200, duration: 0.03, type: 'square', delay: 50 },
  ]},
  folderOpen:  { steps: [
    { frequency: 700, duration: 0.01, type: 'sawtooth' },
    { frequency: 350, duration: 0.02, type: 'square', delay: 10 },
  ]},
  drop:        { steps: [
    { frequency: 180, duration: 0.04, type: 'square' },
    { frequency: 90, duration: 0.06, type: 'square', delay: 20 },
  ]},
  trash:       { steps: Array.from({ length: 3 }, (_, i) => ({
    frequency: 400 - i * 80,
    duration: 0.02,
    type: 'sawtooth' as OscillatorType,
    delay: i * 25,
  }))},
  emptyTrash:  { steps: Array.from({ length: 7 }, (_, i) => ({
    frequency: 500 - i * 50,
    duration: 0.015,
    type: 'sawtooth' as OscillatorType,
    delay: i * 30,
    volume: 1 - i * 0.1,
  }))},
  alert:       { steps: [
    { frequency: 800, duration: 0.05, type: 'square' },
    { frequency: 800, duration: 0.05, type: 'square', delay: 80 },
    { frequency: 800, duration: 0.05, type: 'square', delay: 160 },
  ]},
  error:       { steps: [
    { frequency: 250, duration: 0.1, type: 'square' },
    { frequency: 200, duration: 0.15, type: 'square', delay: 80 },
  ]},
  startup:     { steps: Array.from({ length: 4 }, (_, i) => ({
    frequency: 300 + i * 100,
    duration: 0.03,
    type: 'square' as OscillatorType,
    delay: i * 60,
  }))},
  select:      { steps: [{ frequency: 700, duration: 0.01, type: 'sawtooth' }] },
};

// ---------------------------------------------------------------------------
// Pack registry
// ---------------------------------------------------------------------------

export const BUILTIN_PACKS: Record<BuiltInPackId, PackDefinition> = {
  classic,
  scifi,
  typewriter,
};

export const BUILTIN_PACK_LABELS: Record<BuiltInPackId, string> = {
  classic: 'Classic Mac',
  scifi: 'Sci-Fi',
  typewriter: 'Typewriter',
};

/**
 * Play a sound definition using the Web Audio API.
 */
export function playSynthSound(
  ctx: AudioContext,
  definition: SoundDefinition,
  masterVolume: number
): void {
  for (const step of definition.steps) {
    const delay = step.delay ?? 0;
    const vol = (step.volume ?? 1) * masterVolume;

    setTimeout(() => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.frequency.value = step.frequency;
      oscillator.type = step.type;

      gainNode.gain.setValueAtTime(vol * 0.3, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + step.duration);

      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + step.duration);
    }, delay);
  }
}
