import { SetMetadata } from '@nestjs/common';

export const WORKSPACE_PERMISSION_METADATA = 'knowflow:workspace-permission';

export type WorkspaceAction =
  | 'WORKSPACE_VIEW'
  | 'WORKSPACE_UPDATE'
  | 'WORKSPACE_DELETE'
  | 'KNOWLEDGE_BASE_VIEW'
  | 'KNOWLEDGE_BASE_MANAGE'
  | 'DOCUMENT_VIEW'
  | 'DOCUMENT_UPLOAD'
  | 'DOCUMENT_DELETE'
  | 'MEMBER_LIST'
  | 'MEMBER_INVITE'
  | 'INVITATION_LIST'
  | 'INVITATION_REVOKE'
  | 'MEMBER_REMOVE'
  | 'MEMBER_ROLE_UPDATE';

export type WorkspaceResourceRef =
  | { type: 'workspace'; source: 'param'; key: string }
  | { type: 'knowledgeBase'; source: 'param' | 'body'; key: string }
  | { type: 'document'; source: 'param'; key: string };

export interface WorkspacePermissionMetadata {
  action: WorkspaceAction;
  resource: WorkspaceResourceRef;
}

export function RequireWorkspacePermission(
  action: WorkspaceAction,
  resource: WorkspaceResourceRef,
): MethodDecorator & ClassDecorator {
  return SetMetadata(WORKSPACE_PERMISSION_METADATA, { action, resource });
}

export const workspaceParam = (key: string): WorkspaceResourceRef => ({
  type: 'workspace',
  source: 'param',
  key,
});

export const knowledgeBaseParam = (key: string): WorkspaceResourceRef => ({
  type: 'knowledgeBase',
  source: 'param',
  key,
});

export const knowledgeBaseBody = (key: string): WorkspaceResourceRef => ({
  type: 'knowledgeBase',
  source: 'body',
  key,
});

export const documentParam = (key: string): WorkspaceResourceRef => ({
  type: 'document',
  source: 'param',
  key,
});
