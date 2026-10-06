<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type UploadRequestOptions } from 'element-plus';
import { api, getErrorMessage, streamConversationMessage } from '../api';
import { formatBytes, formatDate, stageText, statusText, statusType } from '../presenters';
import type { ConversationSummary, KnowledgeBase, KnowledgeDocument, RagResponse, WorkspaceRole } from '../types';

const props = defineProps<{ knowledgeBase: KnowledgeBase; workspaceRole: WorkspaceRole; currentUserId: string }>();
const emit = defineEmits<{ edit: []; delete: []; documentsChanged: [] }>();

const activeTab = ref<'documents' | 'ask'>('documents');
const documents = ref<KnowledgeDocument[]>([]);
const selectedDocuments = ref<KnowledgeDocument[]>([]);
const documentsLoading = ref(false);
const asking = ref(false);
const question = ref('');
type ChatEntry = { question: string; result?: Pick<RagResponse, 'answer' | 'sources'>; error?: string; loading: boolean };
type LocalUpload = { key: string; documentId?: string; filename: string; progress: number; controller: AbortController };
const conversation = ref<ChatEntry[]>([]);
const conversationHistory = ref<ConversationSummary[]>([]);
const selectedConversationId = ref('');
const activeUploads = ref<LocalUpload[]>([]);
const messageList = ref<HTMLElement>();
const uploadRef = ref<{ $el: HTMLElement } | null>(null);
let refreshTimer: number | undefined;
let documentRequestInProgress = false;
let activeStreamController: AbortController | undefined;

const readyCount = computed(() => documents.value.filter((item) => item.status === 'READY').length);
const processingCount = computed(
  () => documents.value.filter((item) => item.status === 'PENDING' || item.status === 'PROCESSING').length,
);
const selectableIds = computed(() => new Set(documents.value.map((item) => item.id)));
const canManageKnowledgeBase = computed(() => props.workspaceRole !== 'MEMBER');
const canDeleteAnyDocument = computed(() => props.workspaceRole !== 'MEMBER');

function canSelectDocument(document: KnowledgeDocument): boolean {
  return canDeleteAnyDocument.value || document.uploadedByUserId === props.currentUserId;
}

async function loadDocuments(showLoading = false): Promise<void> {
  if (documentRequestInProgress) return;
  documentRequestInProgress = true;
  if (showLoading) documentsLoading.value = true;
  try {
    documents.value = await api.documents(props.knowledgeBase.id);
    selectedDocuments.value = selectedDocuments.value.filter((item) => selectableIds.value.has(item.id));
  } catch (error) {
    if (showLoading) ElMessage.error(getErrorMessage(error));
  } finally {
    documentRequestInProgress = false;
    documentsLoading.value = false;
  }
}

watch(
  () => props.knowledgeBase.id,
  async () => {
    activeTab.value = 'documents';
    selectedDocuments.value = [];
    conversation.value = [];
    selectedConversationId.value = '';
    conversationHistory.value = [];
    question.value = '';
    await loadDocuments(true);
  },
  { immediate: true },
);

watch(activeTab, (tab) => {
  if (tab === 'ask') void loadConversationHistory();
});

onMounted(() => {
  refreshTimer = window.setInterval(() => {
    if (processingCount.value > 0) void loadDocuments();
  }, 2500);
});

onBeforeUnmount(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  activeStreamController?.abort();
  activeUploads.value.forEach((item) => item.controller.abort());
});

function onSelectionChange(rows: KnowledgeDocument[]): void {
  selectedDocuments.value = rows;
}

async function uploadRequest(options: UploadRequestOptions): Promise<void> {
  const localUpload: LocalUpload = {
    key: crypto.randomUUID(),
    filename: options.file.name,
    progress: 0,
    controller: new AbortController(),
  };
  activeUploads.value.push(localUpload);
  try {
    await api.uploadDocument(
      props.knowledgeBase.id,
      options.file,
      (document) => {
        localUpload.documentId = document.id;
        void loadDocuments();
      },
      (progress) => { localUpload.progress = progress; },
      localUpload.controller.signal,
    );
    options.onSuccess({});
    ElMessage.success(`“${options.file.name}”已直传到 MinIO，正在后台处理`);
    await loadDocuments();
    emit('documentsChanged');
  } catch (error) {
    if (localUpload.controller.signal.aborted) return;
    if (localUpload.documentId) {
      await api.cancelDocument(localUpload.documentId).catch(() => undefined);
      await loadDocuments();
    }
    const uploadError = Object.assign(new Error(getErrorMessage(error)), {
      name: 'UploadAjaxError',
      status: 0,
      method: options.method,
      url: options.action,
    });
    options.onError(uploadError);
    ElMessage.error(`${options.file.name}：${getErrorMessage(error)}`);
  } finally {
    activeUploads.value = activeUploads.value.filter((item) => item.key !== localUpload.key);
  }
}

function beforeUpload(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['txt', 'md', 'markdown', 'pdf', 'docx'].includes(extension ?? '')) {
    ElMessage.warning('仅支持 TXT、Markdown、PDF 和 DOCX 文件');
    return false;
  }
  return true;
}

function canProcessDocument(document: KnowledgeDocument): boolean {
  return props.workspaceRole !== 'MEMBER' || document.uploadedByUserId === props.currentUserId;
}

function canRetryDocument(document: KnowledgeDocument): boolean {
  return document.status === 'FAILED' && document.processingStage !== 'UPLOAD';
}

function uploadPercent(documentId: string): number | undefined {
  return activeUploads.value.find((item) => item.documentId === documentId)?.progress;
}

async function cancelDocumentTask(document: KnowledgeDocument): Promise<void> {
  try {
    const local = activeUploads.value.find((item) => item.documentId === document.id);
    local?.controller.abort();
    await api.cancelDocument(document.id);
    ElMessage.success(`已取消“${document.originalName}”的任务`);
    await loadDocuments();
  } catch (error) {
    ElMessage.error(getErrorMessage(error));
  }
}

async function retryDocument(document: KnowledgeDocument, reindex = false): Promise<void> {
  try {
    if (reindex) await api.reindexDocument(document.id);
    else await api.retryDocument(document.id);
    ElMessage.success(reindex ? '已创建重新索引任务' : '已重新加入处理队列');
    await loadDocuments();
  } catch (error) {
    ElMessage.error(getErrorMessage(error));
  }
}

async function deleteSelected(): Promise<void> {
  const ids = selectedDocuments.value.map((item) => item.id);
  if (ids.length === 0) return;
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${ids.length} 个文档吗？原文件和已处理的文本块也会一并删除。`,
      '删除文档',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
    const result = await api.deleteDocuments(props.knowledgeBase.id, ids);
    ElMessage.success(`已删除 ${result.deletedCount} 个文档`);
    selectedDocuments.value = [];
    await loadDocuments();
    emit('documentsChanged');
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(getErrorMessage(error));
  }
}

async function askQuestion(): Promise<void> {
  const value = question.value.trim();
  if (!value || asking.value) return;
  question.value = '';
  const entry: ChatEntry = { question: value, result: { answer: '', sources: [] }, loading: true };
  conversation.value.push(entry);
  asking.value = true;
  const controller = new AbortController();
  activeStreamController = controller;
  try {
    if (!selectedConversationId.value) {
      const created = await api.createConversation(props.knowledgeBase.id, value.slice(0, 120));
      selectedConversationId.value = created.id;
      await loadConversationHistory();
    }
    await streamConversationMessage(selectedConversationId.value, value, controller.signal, ({ type, data }) => {
      if (type === 'delta') {
        const delta = data as { text?: string };
        entry.result!.answer += delta.text ?? '';
      } else if (type === 'sources') {
        const payload = data as { sources?: RagResponse['sources'] };
        entry.result!.sources = payload.sources ?? [];
      } else if (type === 'error') {
        entry.error = (data as { message?: string }).message || '问答处理失败';
      }
    });
    if (!controller.signal.aborted && !entry.error) await loadConversationHistory();
  } catch (error) {
    if (!controller.signal.aborted) entry.error = getErrorMessage(error);
  } finally {
    if (controller.signal.aborted && !entry.error) entry.error = '已停止生成，本轮未保存到对话历史';
    entry.loading = false;
    asking.value = false;
    activeStreamController = undefined;
    await loadDocuments();
    requestAnimationFrame(() => {
      if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight;
    });
  }
}

function stopAnswer(): void {
  activeStreamController?.abort();
}

function newConversation(): void {
  if (asking.value) return;
  selectedConversationId.value = '';
  conversation.value = [];
}

async function loadConversationHistory(): Promise<void> {
  try {
    conversationHistory.value = await api.conversations(props.knowledgeBase.id);
  } catch {
    conversationHistory.value = [];
  }
}

async function openConversation(conversationId: string): Promise<void> {
  if (asking.value) return;
  try {
    selectedConversationId.value = conversationId;
    const messages = await api.conversationMessages(conversationId);
    const entries: ChatEntry[] = [];
    for (const message of messages) {
      if (message.role === 'USER') entries.push({ question: message.content, loading: false });
      else {
        const previous = entries.at(-1);
        if (previous) previous.result = { answer: message.content, sources: message.citations ?? [] };
      }
    }
    conversation.value = entries;
    requestAnimationFrame(() => {
      if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight;
    });
  } catch (error) {
    ElMessage.error(getErrorMessage(error));
  }
}

function openFilePicker(): void {
  uploadRef.value?.$el.querySelector<HTMLInputElement>('input[type="file"]')?.click();
}
</script>

<template>
  <section class="knowledge-view">
    <header class="page-heading">
      <div>
        <div class="breadcrumb"><span>知识库</span><el-icon><ArrowRight /></el-icon><strong>{{ knowledgeBase.name }}</strong></div>
        <h1>{{ knowledgeBase.name }}</h1>
        <p>{{ knowledgeBase.description || '整理文件，向你的资料提问。' }}</p>
      </div>
      <div class="heading-actions">
        <el-dropdown v-if="canManageKnowledgeBase" trigger="click" @command="(command: string) => command === 'edit' ? emit('edit') : emit('delete')">
          <el-button class="more-button" aria-label="知识库设置"><el-icon><MoreFilled /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="edit"><el-icon><EditPen /></el-icon>编辑知识库</el-dropdown-item>
              <el-dropdown-item command="delete" class="danger-item"><el-icon><Delete /></el-icon>删除知识库</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button v-if="activeTab === 'documents'" type="primary" @click="openFilePicker">
          <el-icon><Upload /></el-icon>添加文档
        </el-button>
        <el-button v-else class="clear-chat-button" @click="newConversation">新建对话</el-button>
      </div>
    </header>

    <div class="view-toolbar">
      <div class="view-tabs" role="tablist">
        <button :class="['view-tab', { active: activeTab === 'documents' }]" @click="activeTab = 'documents'">
          <el-icon><Files /></el-icon>文档 <span class="tab-count">{{ documents.length }}</span>
        </button>
        <button :class="['view-tab', { active: activeTab === 'ask' }]" @click="activeTab = 'ask'">
          <el-icon><ChatDotRound /></el-icon>知识问答
        </button>
      </div>
      <div v-if="activeTab === 'documents'" class="document-summary">
        <span><i class="summary-dot ready-dot"></i>{{ readyCount }} 已就绪</span>
        <span><i class="summary-dot processing-dot"></i>{{ processingCount }} 处理中</span>
      </div>
    </div>

    <div v-show="activeTab === 'documents'" class="documents-pane">
      <el-upload
        ref="uploadRef"
        class="upload-control"
        action="/api/v1/knowledge-bases/upload"
        :http-request="uploadRequest"
        :before-upload="beforeUpload"
        :show-file-list="false"
        :multiple="true"
        accept=".txt,.md,.markdown,.pdf,.docx"
      >
        <div class="upload-hint">
          <span class="upload-hint-icon"><el-icon><UploadFilled /></el-icon></span>
          <span><strong>拖放文件到此处</strong><small>或点击右侧按钮选择文件，支持 TXT、Markdown、PDF、DOCX；默认上限 200 MB，内容直接上传至 MinIO</small></span>
        </div>
      </el-upload>

      <div class="table-heading">
        <div><h2>文档列表</h2><span>{{ documents.length }} 个文件</span></div>
        <div class="table-actions">
          <el-button v-if="selectedDocuments.length" type="danger" plain size="small" @click="deleteSelected">
            <el-icon><Delete /></el-icon>删除所选（{{ selectedDocuments.length }}）
          </el-button>
          <el-button text circle aria-label="刷新文档列表" :loading="documentsLoading" @click="loadDocuments(true)"><el-icon><Refresh /></el-icon></el-button>
        </div>
      </div>

      <el-table
        :data="documents"
        row-key="id"
        class="document-table"
        v-loading="documentsLoading"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="48" :selectable="canSelectDocument" />
        <el-table-column label="文件名称" min-width="250">
          <template #default="scope">
            <div class="file-cell">
              <span class="file-icon"><el-icon><Document /></el-icon></span>
              <span class="file-name-wrap"><strong>{{ scope.row.originalName }}</strong><small>{{ formatBytes(scope.row.sizeBytes) }}</small></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="处理任务" min-width="190">
          <template #default="scope">
            <el-tooltip v-if="scope.row.status === 'FAILED' && scope.row.errorMessage" :content="scope.row.errorMessage" placement="top">
              <el-tag :type="statusType(scope.row.status)" effect="light" round>{{ statusText(scope.row.status) }}</el-tag>
            </el-tooltip>
            <el-tag v-else :type="statusType(scope.row.status)" effect="light" round>{{ statusText(scope.row.status) }}</el-tag>
            <div v-if="scope.row.status === 'PROCESSING' || scope.row.status === 'PENDING'" class="task-progress">
              <small>{{ stageText(scope.row.processingStage) }} · {{ uploadPercent(scope.row.id) ?? scope.row.progress }}%</small>
              <progress :value="uploadPercent(scope.row.id) ?? scope.row.progress" max="100"></progress>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="上传者" min-width="160">
          <template #default="scope">
            <span class="muted-text">{{ scope.row.uploadedByUser?.name || scope.row.uploadedByUser?.email || (workspaceRole === 'MEMBER' ? '历史文档（需管理员删除）' : '历史文档') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="添加时间" width="170">
          <template #default="scope"><span class="muted-text">{{ formatDate(scope.row.createdAt) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="scope">
            <div v-if="canProcessDocument(scope.row)" class="document-task-actions">
              <el-button v-if="canRetryDocument(scope.row)" text type="primary" size="small" @click="retryDocument(scope.row)">重试</el-button>
              <span v-else-if="scope.row.status === 'FAILED' && scope.row.processingStage === 'UPLOAD'" class="muted-text">请重新上传</span>
              <el-button v-if="scope.row.status === 'READY'" text type="primary" size="small" @click="retryDocument(scope.row, true)">重新索引</el-button>
              <el-button v-if="scope.row.status === 'PENDING' || scope.row.status === 'PROCESSING'" text type="danger" size="small" @click="cancelDocumentTask(scope.row)">取消任务</el-button>
            </div>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-documents">
            <span class="empty-icon"><el-icon><Files /></el-icon></span>
            <strong>这个知识库还没有文档</strong>
            <span>上传一些资料，就可以开始提问了。</span>
          </div>
        </template>
      </el-table>
      <p class="privacy-note"><el-icon><Lock /></el-icon>上传的文件只会在此知识库中检索。{{ workspaceRole === 'MEMBER' ? '你可以删除自己上传的文档；历史文档和其他成员的文档由管理员管理。' : '管理员可以管理知识库和其中的所有文档。' }}</p>
    </div>

    <section v-show="activeTab === 'ask'" class="ask-pane">
      <div class="ask-intro">
        <span class="ask-orb"><el-icon><ChatDotRound /></el-icon></span>
        <div><h2>问问你的知识库</h2><p>回答会基于已处理的文档生成，并附上相关来源。</p></div>
      </div>
      <div class="conversation-toolbar">
        <div class="conversation-history-list">
          <button
            v-for="item in conversationHistory"
            :key="item.id"
            :class="['conversation-history-item', { active: item.id === selectedConversationId }]"
            :title="item.title"
            @click="openConversation(item.id)"
          >{{ item.title }}</button>
          <span v-if="conversationHistory.length === 0" class="conversation-history-empty">问题会自动保存为对话</span>
        </div>
      </div>
      <div ref="messageList" class="conversation-list">
        <div v-if="conversation.length === 0" class="conversation-empty">
          <div class="suggestion-icon"><el-icon><MagicStick /></el-icon></div>
          <strong>从一个问题开始</strong>
          <span>试试“这个知识库主要讲了什么？”</span>
          <button class="suggestion-chip" @click="question = '这个知识库主要讲了什么？'">这个知识库主要讲了什么？<el-icon><ArrowRight /></el-icon></button>
        </div>
        <article v-for="(entry, index) in conversation" :key="index" class="conversation-turn">
          <div class="user-question"><span class="user-avatar"><el-icon><User /></el-icon></span><span>{{ entry.question }}</span></div>
          <div class="assistant-answer">
            <span class="assistant-avatar"><el-icon><Connection /></el-icon></span>
            <div class="answer-content">
              <div v-if="entry.loading && !entry.result?.answer" class="answer-loading"><el-icon class="is-loading"><Loading /></el-icon>正在查阅知识库…</div>
              <el-alert v-else-if="entry.error" :title="entry.error" type="error" :closable="false" show-icon />
              <template v-else-if="entry.result">
                <p class="answer-text">{{ entry.result.answer }}</p>
                <div v-if="entry.result.sources.length" class="sources-block">
                  <div class="sources-heading"><span>参考来源</span><span>{{ entry.result.sources.length }} 条</span></div>
                  <div v-for="source in entry.result.sources" :key="`${source.documentId}-${source.chunkIndex}`" class="source-row">
                    <span class="source-number">{{ source.citation }}</span>
                    <span><strong>{{ source.documentName }}</strong><small>{{ source.pageNumber ? `第 ${source.pageNumber} 页 · ` : '' }}{{ source.headingPath?.join(' / ') || `片段 ${source.chunkIndex + 1}` }} · 匹配度 {{ Math.max(0, Math.min(100, Math.round(source.score * 100))) }}%</small></span>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </article>
      </div>
      <form class="question-composer" @submit.prevent="askQuestion">
        <el-input
          v-model="question"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 5 }"
          maxlength="4000"
          show-word-limit
          placeholder="输入一个关于知识库的问题…"
          resize="none"
          @keydown.ctrl.enter.prevent="askQuestion"
        />
        <div class="composer-footer">
          <span><el-icon><InfoFilled /></el-icon>回答由 AI 生成，请结合来源核对信息</span>
          <el-button v-if="asking" type="danger" plain @click="stopAnswer">停止生成</el-button>
          <el-button v-else type="primary" :disabled="!question.trim()" @click="askQuestion">
            发送问题<el-icon><Position /></el-icon>
          </el-button>
        </div>
      </form>
    </section>
  </section>
</template>
