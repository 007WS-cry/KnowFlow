<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type UploadRequestOptions } from 'element-plus';
import { api, getErrorMessage } from '../api';
import { formatBytes, formatDate, statusText, statusType } from '../presenters';
import type { KnowledgeBase, KnowledgeDocument, RagResponse } from '../types';

const props = defineProps<{ knowledgeBase: KnowledgeBase }>();
const emit = defineEmits<{ edit: []; delete: []; documentsChanged: [] }>();

const activeTab = ref<'documents' | 'ask'>('documents');
const documents = ref<KnowledgeDocument[]>([]);
const selectedDocuments = ref<KnowledgeDocument[]>([]);
const documentsLoading = ref(false);
const asking = ref(false);
const question = ref('');
const conversation = ref<Array<{ question: string; result?: RagResponse; error?: string; loading: boolean }>>([]);
const messageList = ref<HTMLElement>();
const uploadRef = ref<{ $el: HTMLElement } | null>(null);
let refreshTimer: number | undefined;
let documentRequestInProgress = false;

const readyCount = computed(() => documents.value.filter((item) => item.status === 'READY').length);
const processingCount = computed(
  () => documents.value.filter((item) => item.status === 'PENDING' || item.status === 'PROCESSING').length,
);
const selectableIds = computed(() => new Set(documents.value.map((item) => item.id)));

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
    question.value = '';
    await loadDocuments(true);
  },
  { immediate: true },
);

onMounted(() => {
  refreshTimer = window.setInterval(() => {
    if (processingCount.value > 0) void loadDocuments();
  }, 2500);
});

onBeforeUnmount(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
});

function onSelectionChange(rows: KnowledgeDocument[]): void {
  selectedDocuments.value = rows;
}

async function uploadRequest(options: UploadRequestOptions): Promise<void> {
  try {
    await api.uploadDocument(props.knowledgeBase.id, options.file);
    options.onSuccess({});
    ElMessage.success(`“${options.file.name}”已上传，正在后台处理`);
    await loadDocuments();
    emit('documentsChanged');
  } catch (error) {
    const uploadError = Object.assign(new Error(getErrorMessage(error)), {
      name: 'UploadAjaxError',
      status: 0,
      method: options.method,
      url: options.action,
    });
    options.onError(uploadError);
    ElMessage.error(`${options.file.name}：${getErrorMessage(error)}`);
  }
}

function beforeUpload(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['txt', 'md', 'markdown', 'pdf', 'docx'].includes(extension ?? '')) {
    ElMessage.warning('仅支持 TXT、Markdown、PDF 和 DOCX 文件');
    return false;
  }
  if (file.size > 10 * 1024 * 1024) {
    ElMessage.warning('文件不能超过 10 MB');
    return false;
  }
  return true;
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
  const entry = { question: value, loading: true } as {
    question: string;
    result?: RagResponse;
    error?: string;
    loading: boolean;
  };
  conversation.value.push(entry);
  asking.value = true;
  try {
    entry.result = await api.ask(props.knowledgeBase.id, value);
  } catch (error) {
    entry.error = getErrorMessage(error);
  } finally {
    entry.loading = false;
    asking.value = false;
    await loadDocuments();
    requestAnimationFrame(() => {
      if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight;
    });
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
        <el-dropdown trigger="click" @command="(command: string) => command === 'edit' ? emit('edit') : emit('delete')">
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
        <el-button v-else class="clear-chat-button" @click="conversation = []">清空对话</el-button>
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
          <span><strong>拖放文件到此处</strong><small>或点击右侧按钮选择文件，支持 TXT、Markdown、PDF、DOCX，单个文件最大 10 MB</small></span>
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
        <el-table-column type="selection" width="48" />
        <el-table-column label="文件名称" min-width="250">
          <template #default="scope">
            <div class="file-cell">
              <span class="file-icon"><el-icon><Document /></el-icon></span>
              <span class="file-name-wrap"><strong>{{ scope.row.originalName }}</strong><small>{{ formatBytes(scope.row.sizeBytes) }}</small></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="处理状态" width="130">
          <template #default="scope">
            <el-tooltip v-if="scope.row.status === 'FAILED' && scope.row.errorMessage" :content="scope.row.errorMessage" placement="top">
              <el-tag :type="statusType(scope.row.status)" effect="light" round>{{ statusText(scope.row.status) }}</el-tag>
            </el-tooltip>
            <el-tag v-else :type="statusType(scope.row.status)" effect="light" round>{{ statusText(scope.row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="添加时间" width="170">
          <template #default="scope"><span class="muted-text">{{ formatDate(scope.row.createdAt) }}</span></template>
        </el-table-column>
        <template #empty>
          <div class="empty-documents">
            <span class="empty-icon"><el-icon><Files /></el-icon></span>
            <strong>这个知识库还没有文档</strong>
            <span>上传一些资料，就可以开始提问了。</span>
          </div>
        </template>
      </el-table>
      <p class="privacy-note"><el-icon><Lock /></el-icon>上传的文件只会在你的知识库中检索。</p>
    </div>

    <section v-show="activeTab === 'ask'" class="ask-pane">
      <div class="ask-intro">
        <span class="ask-orb"><el-icon><ChatDotRound /></el-icon></span>
        <div><h2>问问你的知识库</h2><p>回答会基于已处理的文档生成，并附上相关来源。</p></div>
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
              <div v-if="entry.loading" class="answer-loading"><el-icon class="is-loading"><Loading /></el-icon>正在查阅知识库…</div>
              <el-alert v-else-if="entry.error" :title="entry.error" type="error" :closable="false" show-icon />
              <template v-else-if="entry.result">
                <p class="answer-text">{{ entry.result.answer }}</p>
                <div v-if="entry.result.sources.length" class="sources-block">
                  <div class="sources-heading"><span>参考来源</span><span>{{ entry.result.sources.length }} 条</span></div>
                  <div v-for="source in entry.result.sources" :key="`${source.documentId}-${source.chunkIndex}`" class="source-row">
                    <span class="source-number">{{ source.citation }}</span>
                    <span><strong>{{ source.documentName }}</strong><small>片段 {{ source.chunkIndex + 1 }} · 匹配度 {{ Math.max(0, Math.min(100, Math.round(source.score * 100))) }}%</small></span>
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
          <el-button type="primary" :disabled="!question.trim()" :loading="asking" @click="askQuestion">
            发送问题<el-icon><Position /></el-icon>
          </el-button>
        </div>
      </form>
    </section>
  </section>
</template>
