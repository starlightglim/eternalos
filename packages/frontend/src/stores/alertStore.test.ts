import { beforeEach, expect, test, describe, vi } from 'vitest';
import { useAlertStore } from './alertStore';

beforeEach(() => {
  useAlertStore.getState().closeAlert();
});

describe('alertStore', () => {
  test('starts with no alert', () => {
    expect(useAlertStore.getState().alert).toBeNull();
  });

  test('showError defaults the title to "Error"', () => {
    useAlertStore.getState().showError('boom');
    expect(useAlertStore.getState().alert).toMatchObject({ type: 'error', message: 'boom', title: 'Error' });
  });

  test('showWarning defaults the title to "Warning"; an explicit title wins', () => {
    useAlertStore.getState().showWarning('careful', 'Heads up');
    expect(useAlertStore.getState().alert).toMatchObject({ type: 'warning', title: 'Heads up' });
  });

  test('showConfirm stores both callbacks', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    useAlertStore.getState().showConfirm('Delete it?', onConfirm, onCancel, 'Confirm');
    const alert = useAlertStore.getState().alert;
    expect(alert).toMatchObject({ type: 'confirm', message: 'Delete it?', title: 'Confirm' });
    alert?.onConfirm?.();
    alert?.onCancel?.();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test('closeAlert clears the current alert', () => {
    useAlertStore.getState().showInfo('hi');
    useAlertStore.getState().closeAlert();
    expect(useAlertStore.getState().alert).toBeNull();
  });

  test('a new alert replaces the previous one', () => {
    useAlertStore.getState().showError('first');
    useAlertStore.getState().showInfo('second');
    expect(useAlertStore.getState().alert).toMatchObject({ type: 'info', message: 'second' });
  });
});
