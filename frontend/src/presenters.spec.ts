import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, statusText, statusType } from './presenters';

describe('document presentation helpers', () => {
  it('formats file sizes at readable units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('maps every document state to a label and Element Plus tag type', () => {
    expect(statusText('PENDING')).toBe('等待处理');
    expect(statusType('PENDING')).toBe('info');
    expect(statusText('PROCESSING')).toBe('处理中');
    expect(statusType('PROCESSING')).toBe('warning');
    expect(statusText('READY')).toBe('已就绪');
    expect(statusType('READY')).toBe('success');
    expect(statusText('FAILED')).toBe('处理失败');
    expect(statusType('FAILED')).toBe('danger');
  });

  it('returns a safe placeholder for invalid dates', () => {
    expect(formatDate('not-a-date')).toBe('—');
  });
});
