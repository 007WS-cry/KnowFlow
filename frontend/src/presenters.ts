import type { DocumentStatus } from './types';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function statusText(status: DocumentStatus): string {
  return {
    PENDING: '等待处理',
    PROCESSING: '处理中',
    READY: '已就绪',
    FAILED: '处理失败',
  }[status];
}

export function statusType(status: DocumentStatus): 'info' | 'warning' | 'success' | 'danger' {
  const types: Record<DocumentStatus, 'info' | 'warning' | 'success' | 'danger'> = {
    PENDING: 'info',
    PROCESSING: 'warning',
    READY: 'success',
    FAILED: 'danger',
  };
  return types[status];
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
