# Simple Fitness Recorder · 健身记录助手

> 本地优先的健身记录助手（中文界面）。记录饮食 / 训练 / 身体数据，自动推算每日热量目标与缺口，并提供可视化统计。支持**网页端**与 **Android App** 两种形态，数据全部存在你自己的设备上，不上传任何服务器。
>
> [English version →](README.en.md)

## 界面预览

桌面端在浏览器里跑 FastAPI + Vue 3，手机端是 Capacitor 打包的 Android App（数据存本机）。下面四张图是真实运行截屏。

#### 桌面端 · 今日总览

![网页端今日总览](assets/screenshots/desktop-today.png)

#### 手机端 · 今日总览

<p align="center"><img src="assets/screenshots/mobile-today.png" width="320" alt="手机端今日总览"></p>

#### 桌面端 · 统计分析

![网页端统计分析](assets/screenshots/desktop-stats.png)

#### 手机端 · 统计分析

<p align="center"><img src="assets/screenshots/mobile-stats.png" width="320" alt="手机端统计分析"></p>

## 功能特性

- **三类记录**：饮食（餐次 / 食物 / 分量 / 热量 / 三大宏量）、训练（部位 / 时长 / 消耗 / 备注）、身体（体重 / 体脂 / 腰围），列表内支持行内编辑与软删除（删错可从回收站恢复）。
- **目标与缺口联动**：按 BMR（Mifflin-St Jeor）→ TDEE（活动系数）→ 每日目标（目标系数）推算热量目标；当天训练消耗会实时抬高有效目标，热量环与缺口口径自洽。
- **可视化统计**：热量摄入环、三大宏量进度条、今日概况，以及区间趋势折线、宏量热量占比、训练部位分布等图表。
- **辅助录入**：把视觉大模型的识图结果按模板粘贴进来，本地规则直接解析入库，不消耗对话额度；也支持纯手动填写。
- **AI 助手（可选）**：接入 OpenAI 兼容接口（如 SiliconFlow / DeepSeek）后，可用自然语言建档、记录、查询、删除（删除带二次确认）。不配置也能正常使用全部记录与统计功能。
- **黑白极简 UI**：浅 / 深主题切换；网页端为侧栏布局，手机端为底部导航；右下角悬浮助手不遮挡背后交互。
- **跨端一致**：网页端与手机端共用同一套记录模型，导出 JSON 在两端均可导入，按「记录类型 + 原 id」去重，重复导入不会越导越多。

## 两种使用形态

| | 网页端（桌面） | 手机端（Android） |
| --- | --- | --- |
| 数据存储 | 本机 SQLite（`data/`，不上传） | 本机 IndexedDB（离线可用） |
| 运行方式 | 本地启动 FastAPI，浏览器访问 | 安装 APK，独立 App |
| 适用场景 | 电脑上做记录与复盘 | 随时随地用手机记 |
| AI 配置 | 服务端 `.env` | App 内「设置」页填写，key 仅存本机 |
| 关系 | 两者并存、互不替代，靠 JSON 导出 / 导入互相同步 | 同上 |

## 快速开始

### 网页端

```bash
# 1. 建议用虚拟环境，避免污染系统 Python
python -m venv .venv
.venv\Scripts\activate            # Windows；Mac/Linux 用 source .venv/bin/activate

# 2. 安装依赖
pip install -r requirements.txt

# 3.（可选）配置 AI 助手，不填则对话功能暂不可用，其余功能正常
cp .env.example .env
# 编辑 .env，填入 OpenAI 兼容接口的密钥：
#   LLM_API_KEY=sk-xxx
#   LLM_BASE_URL=https://api.siliconflow.cn/v1   # 任意 OpenAI 兼容服务均可
#   LLM_MODEL=deepseek-ai/DeepSeek-V3

# 4. 启动
python run.py
```

启动后访问 `http://127.0.0.1:8000`。若监听 `0.0.0.0`，同 WiFi 下的手机可直接用局域网地址访问，方便「拍照 → 识图 → 粘贴入库」。

> 直接双击 `run.py` 常因系统 Python 没装依赖而报错，请在已装依赖的虚拟环境（或已装依赖的 Python）里用终端启动。

### 手机端（Android）

下载仓库 `apk/` 目录下的安装包安装即可：

- `fitness-recorder-v1.0.3-release.apk`：正式签名包，可覆盖升级（推荐）
- `fitness-recorder-v1.0.3-debug.apk`：调试签名包，约 3.9MB，可直接安装试用

首次安装需允许「安装未知来源应用」。数据全部存手机本地，可离线使用；在「设置」页填写 OpenAI 兼容接口的 API Key 即可启用 AI 助手（key 只存本机）。

## 数据备份与迁移

设置页（网页端 / 手机端）提供「导出全部 JSON」，包含档案、目标与全部记录（含回收站）。把文件发给他人，对方导入后即可用同一套数据；重复导入按 id 自动去重（并集合并），不会重复累加。

## 技术栈

- **后端**：FastAPI + SQLite + LangGraph（OpenAI 兼容接口，默认 DeepSeek-V3）
- **前端**：Vue 3 + Chart.js（本地内置，离线可用，CDN 兜底）
- **架构**：API-first —— 网页只是客户端之一；手机 App 是纯前端壳（数据存本机），与网页端通过 JSON 导出 / 导入同步

## 从源码构建（可选）

- 网页端：如上 `pip install -r requirements.txt && python run.py`。
- 手机端：`pwa/` 为纯前端 web 资源（Vue 3 + IndexedDB，零构建），`mobile/` 为 Capacitor 6 工程，把 `pwa/` 打包成原生 Android WebView 壳。改完 `pwa/` 后，在 `mobile/` 内 `cap sync` 同步资源再打包；release 需自备签名密钥库（不入库）。Windows 上中文路径 / 沙箱环境有已知坑，可参考项目内的 `capacitor-apk-build` 构建说明。

## 路线图

- [ ] 多档案 / 多用户
- [ ] 训练动作库与计划模板
- [ ] 体重 / 体脂趋势预测
- [ ] 网页端深色主题记忆优化

## 许可证

本项目当前未指定开源许可证。如需用于商业或分发，请先联系作者。
