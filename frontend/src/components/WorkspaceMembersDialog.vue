<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, getErrorMessage } from '../api';
import { formatDate } from '../presenters';
import type {
  User,
  Workspace,
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspaceRole,
} from '../types';

const props = defineProps<{
  modelValue: boolean;
  workspace: Workspace;
  currentUser: User;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  changed: [];
}>();

const members = ref<WorkspaceMember[]>([]);
const invitations = ref<WorkspaceInvitation[]>([]);
const loading = ref(false);
const inviting = ref(false);
const inviteEmail = ref('');
const inviteRole = ref<'ADMIN' | 'MEMBER'>('MEMBER');
const invitationUrl = ref('');
const canInvite = computed(
  () => props.workspace.role === 'OWNER' || props.workspace.role === 'ADMIN',
);
const isOwner = computed(() => props.workspace.role === 'OWNER');

watch(
  () => [props.modelValue, props.workspace.id, props.workspace.role] as const,
  async ([visible, workspaceId, workspaceRole], previous) => {
    if (previous && workspaceId !== previous[1]) {
      invitationUrl.value = '';
      inviteEmail.value = '';
      inviteRole.value = 'MEMBER';
    }
    if (workspaceRole !== 'OWNER' && inviteRole.value === 'ADMIN') {
      inviteRole.value = 'MEMBER';
    }
    if (visible) await loadData();
  },
  { immediate: true },
);

async function loadData(): Promise<void> {
  loading.value = true;
  try {
    const responses = await Promise.all([
      api.workspaceMembers(props.workspace.id),
      canInvite.value ? api.workspaceInvitations(props.workspace.id) : Promise.resolve([]),
    ]);
    members.value = responses[0];
    invitations.value = responses[1];
  } catch (error) {
    ElMessage.error(getErrorMessage(error));
  } finally {
    loading.value = false;
  }
}

function roleName(role: WorkspaceRole): string {
  return { OWNER: '所有者', ADMIN: '管理员', MEMBER: '成员' }[role];
}

function canRemove(member: WorkspaceMember): boolean {
  if (member.role === 'OWNER' || member.userId === props.currentUser.id) return false;
  if (isOwner.value) return true;
  return props.workspace.role === 'ADMIN' && member.role === 'MEMBER';
}

function canChangeRole(member: WorkspaceMember): boolean {
  return isOwner.value && member.role !== 'OWNER' && member.userId !== props.currentUser.id;
}

async function sendInvitation(): Promise<void> {
  const email = inviteEmail.value.trim();
  if (!email || inviting.value) return;
  inviting.value = true;
  invitationUrl.value = '';
  try {
    const invitation = await api.inviteWorkspaceMember(props.workspace.id, email, inviteRole.value);
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = `invite=${encodeURIComponent(invitation.invitationToken)}`;
    invitationUrl.value = url.toString();
    inviteEmail.value = '';
    ElMessage.success(`已创建或更新发往 ${invitation.email} 的邀请`);
    await loadData();
  } catch (error) {
    ElMessage.error(getErrorMessage(error));
  } finally {
    inviting.value = false;
  }
}

async function copyInvitation(): Promise<void> {
  if (!invitationUrl.value) return;
  try {
    await navigator.clipboard.writeText(invitationUrl.value);
    ElMessage.success('邀请链接已复制');
  } catch {
    ElMessage.info('请选中输入框中的邀请链接并手动复制');
  }
}

async function updateRole(member: WorkspaceMember, role: 'ADMIN' | 'MEMBER'): Promise<void> {
  if (member.role === role) return;
  try {
    await api.updateWorkspaceMemberRole(props.workspace.id, member.userId, role);
    ElMessage.success(`已将 ${member.email} 设为${roleName(role)}`);
    await loadData();
    emit('changed');
  } catch (error) {
    ElMessage.error(getErrorMessage(error));
  }
}

async function removeMember(member: WorkspaceMember): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `移除 ${member.email} 后，对方将无法继续访问此 Workspace。`,
      '移除成员',
      { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' },
    );
    await api.removeWorkspaceMember(props.workspace.id, member.userId);
    ElMessage.success('成员已移除');
    await loadData();
    emit('changed');
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(getErrorMessage(error));
  }
}

async function revokeInvitation(invitation: WorkspaceInvitation): Promise<void> {
  try {
    await ElMessageBox.confirm(`撤销发往 ${invitation.email} 的邀请？`, '撤销邀请', {
      confirmButtonText: '撤销',
      cancelButtonText: '取消',
      type: 'warning',
    });
    await api.revokeWorkspaceInvitation(props.workspace.id, invitation.id);
    ElMessage.success('邀请已撤销');
    await loadData();
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(getErrorMessage(error));
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="`${workspace.name} · 团队成员`"
    width="min(820px, calc(100vw - 32px))"
    destroy-on-close
    @close="emit('update:modelValue', false)"
  >
    <div class="workspace-members-dialog" v-loading="loading">
      <div class="members-summary">
        <span class="members-summary-icon"
          ><el-icon><UserFilled /></el-icon
        ></span>
        <span
          ><strong>{{ members.length }} 位成员</strong
          ><small>角色决定成员在此 Workspace 中可以执行的操作</small></span
        >
        <el-tag round effect="light">你的角色：{{ roleName(workspace.role) }}</el-tag>
      </div>

      <div v-if="canInvite" class="member-invite-form">
        <el-form label-position="top" @submit.prevent="sendInvitation">
          <el-form-item label="邀请新成员">
            <div class="invite-fields">
              <el-input
                v-model="inviteEmail"
                type="email"
                placeholder="输入对方注册账号使用的邮箱"
              />
              <el-select v-model="inviteRole" aria-label="邀请角色" class="invite-role-select">
                <el-option label="成员 MEMBER" value="MEMBER" />
                <el-option v-if="isOwner" label="管理员 ADMIN" value="ADMIN" />
              </el-select>
              <el-button
                type="primary"
                :loading="inviting"
                :disabled="!inviteEmail.trim()"
                @click="sendInvitation"
              >
                <el-icon><Message /></el-icon>创建邀请
              </el-button>
            </div>
            <div class="member-invite-hint">
              {{
                isOwner
                  ? '邀请链接有效期 7 天。再次邀请同一邮箱会生成新链接并使旧链接失效。ADMIN 可以管理内容并邀请 MEMBER。'
                  : 'ADMIN 可以邀请 MEMBER，角色无法在此提升。再次邀请同一邮箱会刷新邀请链接。'
              }}
            </div>
          </el-form-item>
        </el-form>
        <div v-if="invitationUrl" class="invitation-link-box">
          <el-input :model-value="invitationUrl" readonly aria-label="邀请链接" />
          <el-button @click="copyInvitation"
            ><el-icon><CopyDocument /></el-icon>复制链接</el-button
          >
        </div>
      </div>

      <div class="member-table-heading">
        <h3>Workspace 成员</h3>
        <span>{{ members.length }} 人</span>
      </div>
      <el-table :data="members" row-key="userId" size="small">
        <el-table-column label="成员" min-width="220">
          <template #default="scope">
            <div class="member-identity">
              <span class="member-avatar">{{
                (scope.row.name || scope.row.email).slice(0, 1).toUpperCase()
              }}</span>
              <span
                ><strong>{{ scope.row.name || scope.row.email }}</strong
                ><small>{{ scope.row.email }}</small></span
              >
              <el-tag v-if="scope.row.userId === currentUser.id" size="small" effect="plain"
                >你</el-tag
              >
            </div>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="150">
          <template #default="scope">
            <el-select
              v-if="canChangeRole(scope.row)"
              :model-value="scope.row.role"
              size="small"
              aria-label="修改成员角色"
              @change="(role: 'ADMIN' | 'MEMBER') => updateRole(scope.row, role)"
            >
              <el-option label="管理员 ADMIN" value="ADMIN" />
              <el-option label="成员 MEMBER" value="MEMBER" />
            </el-select>
            <el-tag
              v-else
              :type="
                scope.row.role === 'OWNER'
                  ? 'warning'
                  : scope.row.role === 'ADMIN'
                    ? 'primary'
                    : 'info'
              "
              effect="light"
              round
            >
              {{ roleName(scope.row.role) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="加入时间" width="150">
          <template #default="scope"
            ><span class="muted-text">{{ formatDate(scope.row.joinedAt) }}</span></template
          >
        </el-table-column>
        <el-table-column v-if="canInvite" label="操作" width="90" align="right">
          <template #default="scope">
            <el-button
              v-if="canRemove(scope.row)"
              text
              type="danger"
              @click="removeMember(scope.row)"
              >移除</el-button
            >
          </template>
        </el-table-column>
        <template #empty><el-empty description="当前没有成员" :image-size="72" /></template>
      </el-table>

      <div v-if="canInvite" class="member-table-heading invitations-heading">
        <h3>待处理邀请</h3>
        <span>{{ invitations.length }} 个</span>
      </div>
      <el-table v-if="canInvite" :data="invitations" row-key="id" size="small">
        <el-table-column prop="email" label="邮箱" min-width="220" />
        <el-table-column label="邀请角色" width="125">
          <template #default="scope">{{ roleName(scope.row.role) }}</template>
        </el-table-column>
        <el-table-column label="有效期至" width="160">
          <template #default="scope"
            ><span class="muted-text">{{ formatDate(scope.row.expiresAt) }}</span></template
          >
        </el-table-column>
        <el-table-column label="操作" width="85" align="right">
          <template #default="scope"
            ><el-button
              v-if="isOwner || scope.row.role === 'MEMBER'"
              text
              type="danger"
              @click="revokeInvitation(scope.row)"
              >撤销</el-button
            ></template
          >
        </el-table-column>
        <template #empty><el-empty description="没有待处理邀请" :image-size="64" /></template>
      </el-table>
    </div>
    <template #footer
      ><el-button @click="emit('update:modelValue', false)">完成</el-button></template
    >
  </el-dialog>
</template>
