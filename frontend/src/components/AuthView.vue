<script setup lang="ts">
import { reactive, ref } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { api, getErrorMessage } from '../api';
import type { SessionResponse } from '../types';

const emit = defineEmits<{ authenticated: [session: SessionResponse] }>();
const isRegister = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();
const form = reactive({ email: '', password: '', name: '', confirmPassword: '' });

const rules: FormRules = {
  email: [
    { required: true, message: '请输入邮箱地址', trigger: 'blur' },
    { type: 'email', message: '请输入有效的邮箱地址', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    {
      trigger: 'blur',
      validator: (_rule, value, callback) => {
        if (!isRegister.value || (typeof value === 'string' && value.length >= 8)) callback();
        else callback(new Error('密码至少需要 8 位'));
      },
    },
  ],
  name: [{ max: 80, message: '名称不能超过 80 个字符', trigger: 'blur' }],
  confirmPassword: [
    {
      validator: (_rule, value, callback) => {
        if (!isRegister.value || value === form.password) callback();
        else callback(new Error('两次输入的密码不一致'));
      },
      trigger: 'blur',
    },
  ],
};

async function submit(): Promise<void> {
  if (!formRef.value || loading.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;

  loading.value = true;
  try {
    const session = isRegister.value
      ? await api.register(form.email, form.password, form.name)
      : await api.login(form.email, form.password);
    emit('authenticated', session);
  } catch (error) {
    ElMessage.error(getErrorMessage(error));
  } finally {
    loading.value = false;
  }
}

function toggleMode(): void {
  isRegister.value = !isRegister.value;
  form.confirmPassword = '';
  formRef.value?.clearValidate();
}
</script>

<template>
  <main class="auth-page">
    <div class="auth-decoration auth-decoration-one"></div>
    <div class="auth-decoration auth-decoration-two"></div>
    <section class="auth-layout">
      <div class="auth-intro">
        <div class="brand-lockup brand-lockup-light">
          <span class="brand-mark"><el-icon><Connection /></el-icon></span>
          <span>KnowFlow</span>
        </div>
        <div class="auth-intro-copy">
          <p class="eyebrow">TEAM KNOWLEDGE WORKSPACE</p>
          <h1>让知识流动起来。</h1>
          <p>把团队资料集中起来，在统一权限下协作检索与提问。</p>
        </div>
        <div class="auth-feature-list">
          <div><span class="feature-icon"><el-icon><Document /></el-icon></span><span>文档集中管理</span></div>
          <div><span class="feature-icon"><el-icon><Search /></el-icon></span><span>答案附带来源</span></div>
          <div><span class="feature-icon"><el-icon><Lock /></el-icon></span><span>Workspace 权限隔离</span></div>
        </div>
        <div class="auth-intro-foot">简洁、清晰，专注你的知识本身。</div>
      </div>

      <div class="auth-form-side">
        <el-card class="auth-card" shadow="never">
          <div class="auth-card-heading">
            <span class="auth-mobile-mark"><el-icon><Connection /></el-icon></span>
            <p class="eyebrow">{{ isRegister ? 'GET STARTED' : 'WELCOME BACK' }}</p>
            <h2>{{ isRegister ? '创建你的账号' : '欢迎回来' }}</h2>
            <p>{{ isRegister ? '创建账号，开始整理你的知识库。' : '登录后继续使用你的知识工作台。' }}</p>
          </div>

          <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent="submit">
            <el-form-item v-if="isRegister" label="称呼" prop="name">
              <el-input v-model="form.name" placeholder="例如：林同学" maxlength="80" size="large">
                <template #prefix><el-icon><User /></el-icon></template>
              </el-input>
            </el-form-item>
            <el-form-item label="邮箱" prop="email">
              <el-input v-model="form.email" type="email" autocomplete="email" placeholder="you@example.com" size="large">
                <template #prefix><el-icon><Message /></el-icon></template>
              </el-input>
            </el-form-item>
            <el-form-item label="密码" prop="password">
              <el-input
                v-model="form.password"
                type="password"
                :autocomplete="isRegister ? 'new-password' : 'current-password'"
                placeholder="请输入密码"
                show-password
                size="large"
                @keyup.enter="submit"
              >
                <template #prefix><el-icon><Lock /></el-icon></template>
              </el-input>
            </el-form-item>
            <el-form-item v-if="isRegister" label="确认密码" prop="confirmPassword">
              <el-input v-model="form.confirmPassword" type="password" placeholder="再次输入密码" show-password size="large" @keyup.enter="submit">
                <template #prefix><el-icon><CircleCheck /></el-icon></template>
              </el-input>
            </el-form-item>
            <el-button class="auth-submit" type="primary" size="large" :loading="loading" @click="submit">
              {{ isRegister ? '创建账号' : '登录工作台' }}
              <el-icon class="button-arrow"><ArrowRight /></el-icon>
            </el-button>
          </el-form>

          <div class="auth-switch">
            {{ isRegister ? '已经有账号？' : '还没有账号？' }}
            <el-button link type="primary" @click="toggleMode">{{ isRegister ? '返回登录' : '创建账号' }}</el-button>
          </div>
        </el-card>
        <p class="auth-legal">登录即表示你在本地使用 KnowFlow 团队知识库服务。</p>
      </div>
    </section>
  </main>
</template>
