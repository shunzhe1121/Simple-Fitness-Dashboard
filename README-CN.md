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

不用装 App。手机浏览器打开服务地址后「添加到主屏幕」，就得到一个独立图标，点开是全屏界面（PWA），没有浏览器地址栏。

- iPhone：Safari 打开 → 分享 → 添加到主屏幕
- Android：Chrome 打开 → 右上菜单 → 添加到主屏幕 / 安装应用

> 历史上发布过 Android APK（旧方案，数据存手机本地，与网页端靠 JSON 导出互导）。构建产物仍在 `apk/` 目录，但已不再更新——现在的方案数据统一留在电脑上，手机只作为访问端。

## 使用

### 网页端

```bash
python run.py
```

访问 http://127.0.0.1:8000；同一 WiFi 下手机可用启动时打印的局域网地址访问。

Windows 上也可以直接双击 `start.bat`，它会拉起服务并在另一个窗口开好公网隧道。

- 记录饮食、训练（部位 / 时长 / 消耗）、身体（体重 / 体脂 / 腰围）；列表支持行内编辑与软删除（可从回收站恢复）。
- 每日热量目标按 BMR（Mifflin-St Jeor）→ TDEE（活动系数）→ 目标系数推算；接入手表数据后改用实测消耗动态调整。
- 饮食录入有三种方式，在页面顶部切换：**图片分析**、**粘贴文本结果**、**手动添加**。
- 粘贴文本**不要求符合模板**：符合的走本地规则、零成本；不符合的才调 AI 兜底。
- 可选：在 `.env` 配置 OpenAI 兼容接口密钥后，即可使用自然语言助手。

### 粘贴识图结果（分层解析）

「粘贴文本结果」这一档接受任意文本——豆包的原始输出、自己整理的菜单、
甚至顺手打的一段「早饭吃了鸡蛋沙拉 465 千卡」都行。解析分两层：

| 层 | 触发条件 | 成本 |
|---|---|---|
| 本地规则 | 文本带 `###` 分隔和「键: 值」特征 | 0 token |
| AI 兜底 | 本地解析后仍有残余片段 | 一次几百 token |

本地层先跑，只有它吃不下**剩下的片段**才交给模型，已命中的部分不重复付费。
两条入口（页面粘贴、AI 助手对话）共用同一套逻辑，口径一致。

一个容易漏的坑：识图输出常带「早 + 午合计」这类汇总行。它一旦被当成
独立记录，全天热量会直接翻倍。服务端在本地层和 AI 层都做了过滤，
命中的汇总行会被跳过并在预览里提示。

AI 兜底需要配文本模型（`LLM_*`），与识图用的视觉模型（`VISION_*`）是两套配置。

### 拍照识餐（图片分析）

适合「平时随手拍、攒到电脑开着时一次性导入」的用法：

1. 把照片传到电脑，在饮食页「图片分析」里一次选中多张（也可以直接把图片拖进来，手机上则弹相机/相册）。
2. 点「识别」，服务端逐张调视觉模型，结果按 `###` 分块汇总后走本地解析。
3. 核对识别结果，确认后批量入库；图片会标记为已入库，不会重复识别。

图片压缩后存在 `data/meals/<日期>/`，原图不上传、不保存。识别失败会给出具体原因（key 不对、余额不足、模型不支持图片等）。

需要单独配一个多模态模型——**文本模型认不了图**：

```bash
# 方案一：小米 MiMo（mimo-v2.6-flash 是全模态模型，认图 + 结构化输出）
VISION_API_KEY=sk-xxxxx
VISION_BASE_URL=https://api.xiaomimimo.com/v1
VISION_MODEL=mimo-v2.6-flash

# 方案二：SiliconFlow
VISION_API_KEY=你的 SiliconFlow key
VISION_BASE_URL=https://api.siliconflow.cn/v1
VISION_MODEL=Qwen/Qwen2.5-VL-7B-Instruct
```

三项留空时会回落到 `LLM_*`，那时识图会明确提示是哪个模型不支持。没配也能上传、看图库、删图。
未充值的 key 会返回 `402 账户余额不足`，这是计费错误不是配置错误——链路是通的，充上钱即可用。

**单张成本量级**：图片压到长边 1280 后约 1300 token，加提示词和 `###` 输出合计约 2000 token。
按 SiliconFlow 现价（Qwen2.5-VL-7B 输入输出均 $0.05/M、72B 均 $0.59/M）：

| 模型 | 单张 | 一天三张 | 一个月 |
|---|---:|---:|---:|
| Qwen2.5-VL-7B | 约 $0.0001 | 约 $0.0003 | 约 $0.01 |
| Qwen2.5-VL-72B | 约 $0.0012 | 约 $0.0035 | 约 $0.10 |

即「零点几分钱」这个量级，比几分钱还低。价格随厂商调整，下单前以官网为准。

### 佳明手表同步

在 `.env` 填好账号即可，日常同步走本地缓存的 OAuth token，不用反复输密码：

```bash
GARMIN_EMAIL=你的佳明账号（手机号也行）
GARMIN_PASSWORD=密码
```

首次登录若遇到短信验证码，跑一次 `python scripts/garmin_login.py` 完成验证即可，token 存在 `data/garmin_tokens/`。

每天早 8 点自动同步一次，也可以在「身体数据」页点「同步最近 7 天」手动触发。拉回来的字段：

| 来源 | 写入 | 说明 |
|---|---|---|
| 睡眠 | 睡眠时长 / 深睡 / REM / 睡眠评分 | |
| 每日汇总 | 步数 / 全天消耗 / 静息心率 / 平均压力 | 全天消耗是「0 点到此刻」的累计值，当天是半截数据，页面按日期判定完整性后再用 |
| 活动 | 跑步、骑行等 → 训练记录 | 自动归类到「有氧 / 全身」 |
| **体重** | 体重 / 体脂 | 见下 |

体重走 `/weight-service/weight/dateRange` 端点，**单位是克**，写入时转成 kg。两点注意：

- **称重是稀疏事件**，所以体重单独用 30 天的回看窗口（逐日数据只有 7 天），电脑关机几天再开机也不会漏掉期间的称重。重复同步是幂等的。
- **没有佳明智能秤时只有体重**，体脂 / BMI / 肌肉量在接口里全是 `null`（那几项要配合 Index 秤才有）。手动在佳明 App 里填的体重也能读到。

设备数据与手填数据按字段合并：**同一天已经手填过的字段一律不覆盖**，设备值只补空缺。所以佳明的体重不会顶掉你在网页上记的数，反过来也不会。

### 清空历史、从某天重新开始

数据都在 `data/fitness.db` 里。**先备份**（里面是真实健康数据，`data/` 已在 `.gitignore` 中）：

```bash
mkdir -p data/backups && cp data/fitness.db data/backups/fitness-before-reset.db
```

然后删掉目标日期之前的记录。`goals`（热量目标）和 `user_profile`（身高 / 体重目标）没有日期列，属于设置，会原样保留：

```python
import sqlite3

CUTOFF = "2026-10-12"   # 保留 >= 这一天
conn = sqlite3.connect("data/fitness.db")
for table in ("diet_records", "workout_records", "body_records",
              "daily_reports", "garmin_sync_log", "meal_images"):
    conn.execute(f"DELETE FROM {table} WHERE date < ?", (CUTOFF,))
conn.commit()
conn.close()
```

顺手把 `data/reports/` 下日期早于截止日的 `.md` 删掉，不然日报列表里还挂着一批已经没有记录的旧日报。

**务必再配一行 `GARMIN_SINCE`**：每天早 8 点的自动同步会回看最近 7 天，而且对窗口内每天都无条件写入，不看同步日志。也就是说光删不拦的话，明天旧日期就被手表数据填回来了：

```bash
GARMIN_SINCE=2026-10-12
```

早于这个日期的同步一律跳过（`garmin._days()` 里过滤），顺带也不会给那些日子补空日报。哪天不需要这条限制了，把 `.env` 里那行删掉重启即可。

## 公网访问（可选）

出门在外也想用，用 Cloudflare 隧道把本机服务映射到公网：不需要公网 IP、不用改路由器、不用买服务器。

```bash
python scripts/tunnel.py
```

它会自动下载 cloudflared（首次约 53 MB），然后打印一个 `https://xxx.trycloudflare.com` 地址和带令牌的完整入口链接。

**关于安全**：不绑定域名时隧道是匿名的，地址泄露就等于把健康数据公开。所以服务默认开启访问令牌校验，令牌在首次启动时自动生成并写入 `.env` 的 `ACCESS_TOKEN`：

- 手机第一次用 `地址/?k=令牌` 打开一次，之后凭 cookie 免输，有效期 180 天
- 任何不带令牌的请求（含 `/docs` 和所有 API）一律返回 401
- 忘了令牌时，直接打开地址会看到一个输入框，填进去即可

**唯一要接受的代价**：临时域名每次重启都会变，换了地址后手机上的主屏幕图标要重新添加一次。想要固定地址有两条路：

| 方案 | 成本 | 说明 |
|---|---|---|
| 自有域名 + named tunnel | 域名年费 | 地址固定，还能叠 Cloudflare Access 邮箱验证 |
| Tailscale Funnel | 免费 | 给的 `*.ts.net` 地址固定、开机自恢复，但不能绑自己的域名 |

### 手机端

手机浏览器打开局域网地址或隧道地址即可，数据都在电脑上。用「添加到主屏幕」得到独立图标，操作体验接近原生 App。

## 项目结构

```
repo/
├── app/                  FastAPI 后端：API 路由、SQLite 数据层、营养/解析逻辑、识图、分层解析、LangGraph Agent
├── static/               网页端前端（Vue 3 + Chart.js，由 FastAPI 托管；含 PWA 清单与图标）
├── pwa/                  旧手机端 web 资源（Vue 3 + IndexedDB，打包进 APK 用，已停止演进）
├── mobile/               Capacitor 6 Android 工程，打包 pwa/
├── apk/                  历史 Android APK 产物
├── scripts/tunnel.py     Cloudflare 临时隧道，把本机服务映射到公网
├── assets/screenshots/   README 截图
├── start.bat             Windows 一键启动（服务 + 隧道）
├── run.py                服务入口
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
