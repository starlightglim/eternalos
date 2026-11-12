import { beforeEach, expect, test, describe, vi } from 'vitest';
import { useCSSPickerStore } from './cssPickerStore';

beforeEach(() => {
  useCSSPickerStore.getState().deactivate();
});

describe('cssPickerStore', () => {
  test('starts inactive with no callback', () => {
    const s = useCSSPickerStore.getState();
    expect(s.isActive).toBe(false);
    expect(s.onSelectorChosen).toBeNull();
  });

  test('activate turns it on and stores the callback', () => {
    const onChosen = vi.fn();
    useCSSPickerStore.getState().activate(onChosen);
    const s = useCSSPickerStore.getState();
    expect(s.isActive).toBe(true);
    s.onSelectorChosen?.('.window');
    expect(onChosen).toHaveBeenCalledWith('.window');
  });

  test('deactivate turns it off and drops the callback', () => {
    useCSSPickerStore.getState().activate(vi.fn());
    useCSSPickerStore.getState().deactivate();
    const s = useCSSPickerStore.getState();
    expect(s.isActive).toBe(false);
    expect(s.onSelectorChosen).toBeNull();
  });
});
