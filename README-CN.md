<p align="center"><b>简体中文</b> · <a href="README.md">English</a></p>

# Simple Fitness Recorder：本地优先的健身记录助手，自动推算每日热量目标，可选 AI 助手

Simple Fitness Recorder 是一个本地优先的健身记录工具，帮助你记录饮食、训练与身体数据，并随时对照每日热量目标。所有数据都存在你自己的设备上，不上传任何服务器。

提供两种形态——网页端（FastAPI + Vue 3）与手机端（Capacitor 打包的 Android App），共用同一套记录模型，通过 JSON 导出 / 导入互相同步。

## 界面预览

#### 桌面端 · 今日总览

![网页端今日总览](assets/screenshots/desktop-today.png)

#### 手机端 · 今日总览

<p align="center"><img src="assets/screenshots/mobile-today.png" width="320" alt="手机端今日总览"></p>

#### 桌面端 · 统计分析

![网页端统计分析](assets/screenshots/desktop-stats.png)

#### 手机端 · 统计分析

<p align="center"><img src="assets/screenshots/mobile-stats.png" width="320" alt="手机端统计分析"></p>

## 安装

### 网页端

需要 Python 3.10+。

```bash
git clone git@github.com:shunzhe1121/Simple-Fitness-Dashboard.git
cd Simple-Fitness-Dashboard
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 手机端

安装 `apk/` 目录下的安装包：

- `apk/fitness-recorder-v1.0.3-release.apk` — 正式签名包，可覆盖升级
- `apk/fitness-recorder-v1.0.3-debug.apk` — 调试签名包，约 3.9 MB，可直接安装试用

最新版本（含两个安装包）也可从 [GitHub Releases](https://github.com/shunzhe1121/Simple-Fitness-Dashboard/releases/tag/v1.0.3) 直接下载。

首次安装需允许「安装未知来源应用」。

## 使用

### 网页端

```bash
python run.py
```

访问 http://127.0.0.1:8000；同一 WiFi 下手机可用启动时打印的局域网地址访问。

- 记录饮食（餐次 / 食物 / 分量 / 热量 / 三大宏量）、训练（部位 / 时长 / 消耗）、身体（体重 / 体脂 / 腰围）；列表支持行内编辑与软删除（可从回收站恢复）。
- 每日热量目标按 BMR（Mifflin-St Jeor）→ TDEE（活动系数）→ 目标系数推算；当天训练消耗会实时抬高有效目标。
- 把视觉模型识图结果按模板粘贴，本地规则直接解析入库，不消耗对话额度。
- 可选：在 `.env` 配置 OpenAI 兼容接口密钥后，即可使用自然语言助手。

### 手机端

直接运行 App，数据全部存手机本地（IndexedDB），可离线使用。在「设置」页填 OpenAI 兼容接口密钥即可启用 AI 助手；「导出全部 JSON」用于备份、迁移或分享，重复导入按「记录类型 + id」自动去重。

## 项目结构

```
repo/
├── app/                  FastAPI 后端：API 路由、SQLite 数据层、营养/解析逻辑、LangGraph Agent
├── static/               网页端前端（Vue 3 + Chart.js，由 FastAPI 托管）
├── pwa/                  手机端 web 资源（Vue 3 + IndexedDB，零构建，打包进 APK）
├── mobile/               Capacitor 6 Android 工程，打包 pwa/
├── apk/                  Android APK 构建产物
├── assets/screenshots/   README 截图
├── run.py                网页端入口
└── requirements.txt      Python 依赖
```

| 路径 | 用途 | 关联 |
|---|---|---|
| `app/` | FastAPI 后端：路由、SQLite 数据层、营养、解析、LangGraph Agent | 托管 `static/`；与 `pwa/` 共用记录模型 |
| `static/` | 网页端前端（Vue 3） | `app/` 的 `/api` 客户端 |
| `pwa/` | 手机端 web 资源（Vue 3 + IndexedDB） | 由 `mobile/` 打包；与 `app/` 通过 JSON 导出/导入同步 |
| `mobile/` | Capacitor 6 Android 工程 | 把 `pwa/` 打包成 `apk/` 里的 APK |
| `apk/` | Android APK 产物 | `mobile/` 构建输出 |

## 参与贡献

1. Fork 本仓库。
2. 新建分支：`git checkout -b feature/xxx`。
3. 修改代码并补充测试。
4. 本地跑通全部测试。
5. 提交 PR 时说明：(a) 动机，(b) 影响范围。

## 许可证

MIT —— 详见 [LICENSE](LICENSE) 文件。

## 联系

在 https://github.com/shunzhe1121/Simple-Fitness-Dashboard/issues 提 Issue。
