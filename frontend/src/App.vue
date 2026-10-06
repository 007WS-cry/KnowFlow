<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import AuthView from './components/AuthView.vue';
import KnowledgeBaseView from './components/KnowledgeBaseView.vue';
import WorkspaceMembersDialog from './components/WorkspaceMembersDialog.vue';
import { api, clearAccessToken, getAccessToken, getErrorMessage, setAccessToken } from './api';
import type { KnowledgeBase, SessionResponse, User, Workspace } from './types';

const WORKSPACE_KEY = 'knowflow.activeWorkspace';
const authReady = ref(false);
const currentUser = ref<User | null>(null);
const workspaces = ref<Workspace[]>([]);
const knowledgeBases = ref<KnowledgeBase[]>([]);
const activeWorkspaceId = ref('');
const activeKnowledgeBaseId = ref('');
const isRefreshing = ref(false);
const loadError = ref('');
const membersDialogVisible = ref(false);

type DialogMode = 'workspace' | 'editWorkspace' | 'knowledgeBase' | 'editKnowledgeBase';
const dialogMode = ref<DialogMode>('workspace');
const dialogVisible = ref(false);
const saving = ref(false);
const form = reactive({ name: '', description: '' });

const activeWorkspace = computed(
  () => workspaces.value.find((workspace) => workspace.id === activeWorkspaceId.value) ?? null,
);
const activeKnowledgeBase = computed(
  () => knowledgeBases.value.find((knowledgeBase) => knowledgeBase.id === activeKnowledgeBaseId.value) ?? null,
);
const dialogTitle = computed(() => ({
  workspace: '创建 Workspace',
  editWorkspace: '编辑 Workspace',
  knowledgeBase: '创建知识库',
  editKnowledgeBase: '编辑知识库',
}[dialogMode.value]));
const profileInitial = computed(() => (currentUser.value?.name || currentUser.value?.email || 'K').slice(0, 1).toUpperCase());
const canManageKnowledgeBases = computed(
  () => activeWorkspace.value?.role === 'OWNER' || activeWorkspace.value?.role === 'ADMIN',
);
const isWorkspaceOwner = computed(() => activeWorkspace.value?.role === 'OWNER');

function pendingInvitationToken(): string | null {
  const match = window.location.hash.match(/(?:^#|&)invite=([^&]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

async function acceptPendingInvitation(): Promise<void> {
  if (!currentUser.value) return;
  const token = pendingInvitationToken();
  if (!token) return;
  try {
    const accepted = await api.acceptWorkspaceInvitation(token);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    await loadWorkspaces(accepted.workspace.id);
    ElMessage.success(`已加入 Workspace「${accepted.workspace.name}」，角色：${accepted.role}`);
  } catch (error) {
    ElMessage.error(`${getErrorMessage(error)}。请使用收到邀请的邮箱账号登录后再接受。`);
  }
}

function onInvitationHashChange(): void {
  if (currentUser.value) void acceptPendingInvitation();
}

async function loadKnowledgeBases(preferredId?: string): Promise<void> {
  if (!activeWorkspaceId.value) {
    knowledgeBases.value = [];
    activeKnowledgeBaseId.value = '';
    return;
  }
  const previousId = preferredId || activeKnowledgeBaseId.value;
  knowledgeBases.value = await api.knowledgeBases(activeWorkspaceId.value);
  activeKnowledgeBaseId.value = knowledgeBases.value.some((item) => item.id === previousId)
    ? previousId
    : knowledgeBases.value[0]?.id ?? '';
}

async function loadWorkspaces(preferredId?: string): Promise<void> {
  workspaces.value = await api.workspaces();
  const savedId = preferredId || localStorage.getItem(WORKSPACE_KEY) || activeWorkspaceId.value;
  activeWorkspaceId.value = workspaces.value.some((item) => item.id === savedId)
    ? savedId
    : workspaces.value[0]?.id ?? '';
  if (activeWorkspaceId.value) localStorage.setItem(WORKSPACE_KEY, activeWorkspaceId.value);
  else localStorage.removeItem(WORKSPACE_KEY);
  activeKnowledgeBaseId.value = '';
  await loadKnowledgeBases();
}

onMounted(async () => {
  window.addEventListener('hashchange', onInvitationHashChange);
  if (!getAccessToken()) {
    authReady.value = true;
    return;
  }
  try {
    currentUser.value = await api.me();
    await loadWorkspaces();
    await acceptPendingInvitation();
  } catch {
    clearAccessToken();
    currentUser.value = null;
  } finally {
    authReady.value = true;
  }
});

onBeforeUnmount(() => window.removeEventListener('hashchange', onInvitationHashChange));

async function onAuthenticated(session: SessionResponse): Promise<void> {
  setAccessToken(session.accessToken);
  currentUser.value = session.user;
  loadError.value = '';
  isRefreshing.value = true;
  try {
    await loadWorkspaces();
    await acceptPendingInvitation();
  } catch (error) {
    loadError.value = getErrorMessage(error);
  } finally {
    isRefreshing.value = false;
  }
}

async function changeWorkspace(id: string): Promise<void> {
  activeWorkspaceId.value = id;
  activeKnowledgeBaseId.value = '';
  localStorage.setItem(WORKSPACE_KEY, id);
  loadError.value = '';
  try {
    await loadKnowledgeBases();
  } catch (error) {
    loadError.value = getErrorMessage(error);
  }
}

async function refreshData(): Promise<void> {
  isRefreshing.value = true;
  loadError.value = '';
  try {
    await loadWorkspaces(activeWorkspaceId.value);
  } catch (error) {
    loadError.value = getErrorMessage(error);
  } finally {
    isRefreshing.value = false;
  }
}

function selectKnowledgeBase(id: string): void {
  activeKnowledgeBaseId.value = id;
}

function openCreateWorkspace(): void {
  dialogMode.value = 'workspace';
  form.name = '';
  form.description = '';
  dialogVisible.value = true;
}

function openCreateKnowledgeBase(): void {
  if (!canManageKnowledgeBases.value) return;
  dialogMode.value = 'knowledgeBase';
  form.name = '';
  form.description = '';
  dialogVisible.value = true;
}

function openEditWorkspace(): void {
  if (!activeWorkspace.value || !isWorkspaceOwner.value) return;
  dialogMode.value = 'editWorkspace';
  form.name = activeWorkspace.value.name;
  form.description = '';
  dialogVisible.value = true;
}

function openEditKnowledgeBase(): void {
  if (!activeKnowledgeBase.value || !canManageKnowledgeBases.value) return;
  dialogMode.value = 'editKnowledgeBase';
  form.name = activeKnowledgeBase.value.name;
  form.description = activeKnowledgeBase.value.description ?? '';
  dialogVisible.value = true;
}

async function saveDialog(): Promise<void> {
  const name = form.name.trim();
  if (!name || saving.value) return;
  saving.value = true;
  try {
    if (dialogMode.value === 'workspace') {
      const created = await api.createWorkspace(name);
      await loadWorkspaces(created.id);
      ElMessage.success('Workspace 已创建');
    } else if (dialogMode.value === 'editWorkspace' && activeWorkspace.value) {
      await api.updateWorkspace(activeWorkspace.value.id, name);
      await loadWorkspaces(activeWorkspace.value.id);
      ElMessage.success('Workspace 已更新');
    } else if (dialogMode.value === 'knowledgeBase' && activeWorkspaceId.value) {
      const created = await api.createKnowledgeBase(activeWorkspaceId.value, name, form.description.trim());
      await loadKnowledgeBases(created.id);
      ElMessage.success('知识库已创建');
    } else if (dialogMode.value === 'editKnowledgeBase' && activeKnowledgeBase.value) {
      await api.updateKnowledgeBase(activeKnowledgeBase.value.id, name, form.description.trim());
      await loadKnowledgeBases(activeKnowledgeBase.value.id);
      ElMessage.success('知识库已更新');
    }
    dialogVisible.value = false;
  } catch (error) {
    ElMessage.error(getErrorMessage(error));
  } finally {
    saving.value = false;
  }
}

async function deleteKnowledgeBase(): Promise<void> {
  if (!activeKnowledgeBase.value || !canManageKnowledgeBases.value) return;
  try {
    await ElMessageBox.confirm(
      `删除“${activeKnowledgeBase.value.name}”会一并删除其中的文档及处理结果。`,
      '删除知识库',
      { confirmButtonText: '删除知识库', cancelButtonText: '取消', type: 'warning' },
    );
    await api.deleteKnowledgeBase(activeKnowledgeBase.value.id);
    ElMessage.success('知识库已删除');
    await loadKnowledgeBases();
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(getErrorMessage(error));
  }
}

async function deleteWorkspace(): Promise<void> {
  if (!activeWorkspace.value || !isWorkspaceOwner.value) return;
  try {
    await ElMessageBox.confirm(
      `删除“${activeWorkspace.value.name}”会永久删除该空间内的知识库和文档。`,
      '删除 Workspace',
      { confirmButtonText: '删除 Workspace', cancelButtonText: '取消', type: 'warning' },
    );
    await api.deleteWorkspace(activeWorkspace.value.id);
    ElMessage.success('Workspace 已删除');
    await loadWorkspaces();
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(getErrorMessage(error));
  }
}

async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // The local session should still be cleared if the API is offline.
  }
  clearAccessToken();
  currentUser.value = null;
  workspaces.value = [];
  knowledgeBases.value = [];
  activeWorkspaceId.value = '';
  activeKnowledgeBaseId.value = '';
}
</script>

<template>
  <el-config-provider :locale="zhCn">
  <div v-if="!authReady" class="boot-screen"><span class="boot-mark"><el-icon><Connection /></el-icon></span><el-icon class="is-loading"><Loading /></el-icon><span>正在打开工作台…</span></div>
  <AuthView v-else-if="!currentUser" @authenticated="onAuthenticated" />

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span class="brand-mark"><el-icon><Connection /></el-icon></span>
        <span class="brand-name">KnowFlow</span>
        <span class="brand-pill">团队空间</span>
      </div>

      <div class="sidebar-section workspace-section">
        <div class="section-label"><span>WORKSPACE</span><el-icon><OfficeBuilding /></el-icon></div>
        <div class="workspace-control">
          <el-select
            v-model="activeWorkspaceId"
            class="workspace-select"
            placeholder="选择 Workspace"
            :disabled="workspaces.length === 0"
            @change="changeWorkspace"
          >
            <template #prefix><span class="workspace-select-icon"><el-icon><Grid /></el-icon></span></template>
            <el-option v-for="workspace in workspaces" :key="workspace.id" :label="workspace.name" :value="workspace.id">
              <div class="workspace-option"><span>{{ workspace.name }}</span><small>{{ workspace.role === 'OWNER' ? '所有者' : workspace.role === 'ADMIN' ? '管理员' : '成员' }}</small></div>
            </el-option>
          </el-select>
          <el-dropdown v-if="activeWorkspace && isWorkspaceOwner" trigger="click" @command="(command: string) => command === 'edit' ? openEditWorkspace() : deleteWorkspace()">
            <el-button text class="workspace-menu-button" aria-label="Workspace 设置"><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="edit"><el-icon><EditPen /></el-icon>重命名</el-dropdown-item>
                <el-dropdown-item command="delete" class="danger-item"><el-icon><Delete /></el-icon>删除 Workspace</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <button class="sidebar-create-link" @click="openCreateWorkspace"><el-icon><Plus /></el-icon>新建 Workspace</button>
      </div>

      <div class="sidebar-section library-section">
        <div class="library-heading">
          <div class="section-label"><span>知识库</span><span class="library-count">{{ knowledgeBases.length }}</span></div>
          <el-tooltip v-if="canManageKnowledgeBases" content="新建知识库" placement="top"><el-button text circle class="add-library-button" :disabled="!activeWorkspace" aria-label="新建知识库" @click="openCreateKnowledgeBase"><el-icon><Plus /></el-icon></el-button></el-tooltip>
        </div>
        <div v-if="!activeWorkspace" class="sidebar-empty">先创建一个 Workspace</div>
        <div v-else-if="knowledgeBases.length === 0" class="sidebar-empty">还没有知识库</div>
        <button
          v-for="knowledgeBase in knowledgeBases"
          :key="knowledgeBase.id"
          :class="['knowledge-nav-item', { selected: knowledgeBase.id === activeKnowledgeBaseId }]"
          @click="selectKnowledgeBase(knowledgeBase.id)"
        >
          <span class="knowledge-nav-icon"><el-icon><Collection /></el-icon></span>
          <span class="knowledge-nav-name">{{ knowledgeBase.name }}</span>
          <span class="knowledge-nav-count">{{ knowledgeBase._count.documents }}</span>
        </button>
        <el-button v-if="activeWorkspace && canManageKnowledgeBases && knowledgeBases.length === 0" class="sidebar-first-create" @click="openCreateKnowledgeBase"><el-icon><Plus /></el-icon>创建知识库</el-button>
      </div>

      <div class="sidebar-bottom">
        <div class="sidebar-help"><span class="help-icon"><el-icon><QuestionFilled /></el-icon></span><span><strong>使用小提示</strong><small>上传文档后稍等片刻<br />处理完成即可开始提问</small></span></div>
        <div class="profile-row">
          <span class="profile-avatar">{{ profileInitial }}</span>
          <span class="profile-details"><strong>{{ currentUser.name || 'KnowFlow 用户' }}</strong><small>{{ currentUser.email }}</small></span>
          <el-dropdown trigger="click" @command="logout">
            <el-button text class="profile-menu-button" aria-label="账号菜单"><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item command="logout"><el-icon><SwitchButton /></el-icon>退出登录</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </div>
    </aside>

    <main class="main-area">
      <header class="topbar">
        <div class="topbar-context"><span>我的空间</span><el-icon><ArrowRight /></el-icon><strong>{{ activeWorkspace?.name || 'Workspace' }}</strong></div>
        <div class="topbar-actions">
          <el-button v-if="activeWorkspace" text class="team-members-topbar-button" @click="membersDialogVisible = true">
            <el-icon><UserFilled /></el-icon>团队成员
            <el-tag size="small" effect="plain">{{ activeWorkspace.role }}</el-tag>
          </el-button>
          <span class="connection-indicator"><i></i>本地工作台</span>
          <el-tooltip content="重新加载空间和知识库" placement="bottom"><el-button text circle :loading="isRefreshing" aria-label="刷新工作台" @click="refreshData"><el-icon><Refresh /></el-icon></el-button></el-tooltip>
        </div>
      </header>

      <div v-if="loadError" class="main-load-error"><el-alert :title="loadError" type="error" show-icon :closable="false"><template #default><el-button link type="primary" @click="refreshData">重试</el-button></template></el-alert></div>

      <KnowledgeBaseView
        v-if="activeKnowledgeBase"
        :knowledge-base="activeKnowledgeBase"
        :workspace-role="activeWorkspace?.role ?? 'MEMBER'"
        :current-user-id="currentUser.id"
        @edit="openEditKnowledgeBase"
        @delete="deleteKnowledgeBase"
        @documents-changed="loadKnowledgeBases(activeKnowledgeBaseId)"
      />

      <section v-else class="welcome-view">
        <div class="welcome-copy">
          <p class="eyebrow">YOUR KNOWLEDGE, IN FLOW</p>
          <h1>{{ activeWorkspace ? (canManageKnowledgeBases ? '搭建你的第一个知识库' : '等待团队知识库就绪') : '欢迎来到 KnowFlow' }}</h1>
          <p>{{ activeWorkspace ? (canManageKnowledgeBases ? '从上传资料开始，把零散的信息变成随时可查的答案。' : '管理员创建知识库后，你就可以上传团队资料并开始提问。') : '创建一个 Workspace 来安放你的知识库和资料。' }}</p>
          <el-button v-if="activeWorkspace && canManageKnowledgeBases" type="primary" size="large" @click="openCreateKnowledgeBase"><el-icon><Plus /></el-icon>创建知识库</el-button>
          <el-button v-else-if="activeWorkspace" type="primary" size="large" @click="membersDialogVisible = true"><el-icon><UserFilled /></el-icon>查看团队成员</el-button>
          <el-button v-else type="primary" size="large" @click="openCreateWorkspace"><el-icon><Plus /></el-icon>创建 Workspace</el-button>
        </div>
        <div class="welcome-art" aria-hidden="true">
          <div class="art-glow"></div>
          <div class="art-card art-card-back"><span class="art-line long"></span><span class="art-line"></span><span class="art-line short"></span></div>
          <div class="art-card art-card-front"><span class="art-file"><el-icon><Document /></el-icon></span><span class="art-line long"></span><span class="art-line"></span><span class="art-highlight"></span></div>
          <span class="art-spark art-spark-one">✦</span><span class="art-spark art-spark-two">✧</span><span class="art-orbit"></span>
        </div>
        <div class="welcome-steps">
          <article><span class="step-number">01</span><span class="step-icon"><el-icon><Collection /></el-icon></span><strong>{{ canManageKnowledgeBases ? '创建知识库' : '打开团队知识库' }}</strong><small>{{ canManageKnowledgeBases ? '按主题整理你的资料' : '查看管理员创建的资料库' }}</small></article>
          <el-icon class="step-arrow"><ArrowRight /></el-icon>
          <article><span class="step-number">02</span><span class="step-icon"><el-icon><Upload /></el-icon></span><strong>上传文档</strong><small>支持常见办公文件</small></article>
          <el-icon class="step-arrow"><ArrowRight /></el-icon>
          <article><span class="step-number">03</span><span class="step-icon"><el-icon><ChatDotRound /></el-icon></span><strong>开始提问</strong><small>答案附带原文来源</small></article>
        </div>
        <div class="welcome-foot"><span><el-icon><Lock /></el-icon>你的资料按 Workspace 隔离存储</span><span>KnowFlow Workspace</span></div>
      </section>
    </main>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="440px" :close-on-click-modal="false" destroy-on-close>
      <el-form label-position="top" @submit.prevent="saveDialog">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" :maxlength="dialogMode.includes('Workspace') || dialogMode === 'workspace' ? 100 : 120" show-word-limit autofocus :placeholder="dialogMode.toLowerCase().includes('workspace') ? '例如：个人空间' : '例如：产品资料库'" @keyup.enter="saveDialog" />
        </el-form-item>
        <el-form-item v-if="dialogMode === 'knowledgeBase' || dialogMode === 'editKnowledgeBase'" label="描述（可选）">
          <el-input v-model="form.description" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="简单描述这个知识库包含的内容" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!form.name.trim()" :loading="saving" @click="saveDialog">保存</el-button>
      </template>
    </el-dialog>

    <WorkspaceMembersDialog
      v-if="activeWorkspace && currentUser"
      v-model="membersDialogVisible"
      :workspace="activeWorkspace"
      :current-user="currentUser"
      @changed="refreshData"
    />
  </div>
  </el-config-provider>
</template>
