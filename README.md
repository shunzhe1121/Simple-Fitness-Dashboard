# Simple Fitness Dashboard

本地优先的健身记录助手：记录饮食 / 训练 / 身体数据，由 LLM Agent 驱动自然语言交互，配套 Vue 单页前端做可视化总览与统计分析。

## 功能

- **数据记录**：饮食（餐次、食物、分量、热量、三大宏量）、训练（部位、时长、消耗、备注）、身体（体重、体脂、腰围）。列表支持行内编辑与软删除。
- **LLM Agent**：基于 LangGraph 的对话助手，支持自然语言建档、记录、查询、删除二次确认、页面导航。未配置 LLM 时优雅降级，网页功能不受影响。
- **目标与缺口联动**：按 BMR（Mifflin-St Jeor）→ TDEE（活动系数）→ 每日目标（目标系数）推算；当日训练消耗实时抬升有效目标，缺口口径与热量环自洽。
- **可视化**：热量摄入环、三大宏量进度、今日概况、训练 / 饮食记录、区间统计图表（趋势折线、宏量占比、训练部位分布）。
- **黑白极简 UI**：浅 / 深主题切换，右下角悬浮助手（浮窗不遮挡背后交互）。

## 技术栈

- 后端：FastAPI + SQLite + LangGraph（`deepseek-ai/DeepSeek-V3`，经 SiliconFlow 接入）
- 前端：Vue 3 + Chart.js（本地 vendor，离线可用，CDN 兜底）
- 架构：API-first，网页仅作客户端；原生 App 可直接复用 `/api`

## 快速开始

```bash
# 1. 安装依赖（建议使用虚拟环境）
pip install -r requirements.txt

# 2. 配置 LLM（可选，不填则 Agent 不可用但网页正常）
cp .env.example .env
# 编辑 .env，填入硅基流动 key：
#   LLM_API_KEY=sk-xxx
#   LLM_BASE_URL=https://api.siliconflow.cn/v1
#   LLM_MODEL=deepseek-ai/DeepSeek-V3

# 3. 启动
python run.py
```

服务监听 `0.0.0.0:8000`。本机访问 `http://127.0.0.1:8000`；同 WiFi 下手机用局域网 IP 访问。

## 项目结构

```
app/
  api.py            FastAPI 路由层
  repository.py     数据层（SQLite 读写、汇总计算）
  nutrition.py      营养/目标/缺口计算
  parser.py         识图文本解析（提取宏量）
  agent/            LangGraph Agent（graph.py + tools.py）
  db.py config.py utils.py
static/
  index.html        Vue 3 SPA
  js/app.js         SPA 逻辑
  css/style.css
  vendor/           Vue + Chart.js 本地副本
run.py              入口
```

## 数据说明

- `.env`（含 API key）与 `data/`（SQLite 含真实健康数据）已加入 `.gitignore`，**不会上传**。
- 仅仓库内置 `.env.example` 模板，不含任何密钥。
