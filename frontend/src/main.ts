import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { migrateRectificationData } from './data/rectification-flow'
import { migrateAcceptanceData } from './data/acceptance-flow'
import './styles/global.css'

// 历史数据先归一到统一口径（镜像字段对齐、逾期结论冻结保留），再挂载页面。
migrateRectificationData()
migrateAcceptanceData()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
