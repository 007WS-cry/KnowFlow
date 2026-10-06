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
    CANCELLED: '已取消',
  }[status];
}

export function statusType(status: DocumentStatus): 'info' | 'warning' | 'success' | 'danger' {
  const types: Record<DocumentStatus, 'info' | 'warning' | 'success' | 'danger'> = {
    PENDING: 'info',
    PROCESSING: 'warning',
    READY: 'success',
    FAILED: 'danger',
    CANCELLED: 'info',
  };
  return types[status];
}

export function stageText(stage: string): string {
  return {
    UPLOAD: '上传中',
    QUEUED: '排队中',
    PARSING: '解析中',
    CHUNKING: '结构化切块',
    EMBEDDING: '生成向量',
    INDEXING: '写入索引',
    COMPLETE: '已完成',
  }[stage] ?? stage;
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
