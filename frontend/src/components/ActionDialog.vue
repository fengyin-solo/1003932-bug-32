<template>
  <div v-if="open" class="modal-mask" @click.self="cancel">
    <div class="modal-card" role="dialog" :aria-label="title">
      <header class="modal-head">
        <h3>{{ title }}</h3>
        <button class="link" type="button" :disabled="busy" @click="cancel">关闭</button>
      </header>
      <form class="modal-body" @submit.prevent="submit">
        <label v-for="field in fields" :key="field.name" class="form-item">
          <span>{{ field.label }}<em v-if="field.required">*</em></span>
          <textarea
            v-if="field.type === 'textarea'"
            v-model="form[field.name]"
            rows="3"
            :placeholder="field.placeholder ?? ''"
          ></textarea>
          <input
            v-else
            v-model="form[field.name]"
            :type="field.type === 'date' ? 'date' : 'text'"
            :placeholder="field.placeholder ?? ''"
          />
        </label>
        <p v-if="hint" class="form-hint">{{ hint }}</p>
        <footer class="modal-foot">
          <button class="btn" type="button" :disabled="busy" @click="cancel">取消</button>
          <button class="btn primary" type="submit" :disabled="busy">
            {{ busy ? '提交中…' : '确认提交' }}
          </button>
        </footer>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue'

export type DialogField = {
  name: string
  label: string
  type?: 'text' | 'date' | 'textarea'
  required?: boolean
  placeholder?: string
  defaultValue?: string
}

const props = defineProps<{
  open: boolean
  title: string
  fields: DialogField[]
  hint?: string
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', values: Record<string, string>): void
  (e: 'cancel'): void
}>()

const form = reactive<Record<string, string>>({})

watch(
  () => [props.open, props.fields],
  () => {
    for (const field of props.fields) {
      form[field.name] = field.defaultValue ?? ''
    }
  },
  { immediate: true },
)

function submit() {
  const values: Record<string, string> = {}
  for (const field of props.fields) {
    const value = (form[field.name] ?? '').trim()
    if (field.required && !value) return
    values[field.name] = value
  }
  emit('submit', values)
}

function cancel() {
  emit('cancel')
}
</script>
