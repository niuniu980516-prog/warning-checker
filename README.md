# 廣告文宣合規警語檢查工具

基金廣告文宣的自動化合規檢查平台。上傳 Word / PowerPoint / PDF 文件後，系統會自動執行程式規則檢查與 AI 智慧分析，產出標注違規位置的文件與填寫完成的檢查表。

---

## 目錄

1. [系統需求](#系統需求)
2. [快速啟動](#快速啟動)
3. [環境變數說明](#環境變數說明)
4. [第一次登入與初始設定](#第一次登入與初始設定)
5. [專案架構說明](#專案架構說明)
6. [功能說明](#功能說明)
7. [管理後台說明](#管理後台說明)
8. [日常維護](#日常維護)
9. [常見問題](#常見問題)

---

## 系統需求

| 項目 | 最低需求 |
|------|---------|
| 作業系統 | Windows 10/11、macOS 12+、Ubuntu 20.04+ |
| Docker | Docker Desktop 4.x 以上（含 Docker Compose v2） |
| RAM | 4 GB 以上（建議 8 GB） |
| 硬碟 | 10 GB 以上可用空間（Ollama 模型約 5 GB） |
| 網路 | 首次啟動需下載 Docker image，之後可離線運行（使用 Ollama 時） |

> **AI 引擎選擇：**
> - **Claude（Anthropic）** — 雲端 API，效果最佳，需付費 API Key，需要網路
> - **Gemini（Google）** — 雲端 API，需付費 API Key，需要網路
> - **Ollama** — 本機運行，免費，不需網路，但效果稍差，需要較多 RAM

---

## 快速啟動

### 步驟一：取得程式碼

```bash
git clone https://github.com/niuniu980516-prog/warning-checker.git
cd warning-checker
```

### 步驟二：建立環境變數檔案

```bash
cp .env.example .env
```

用文字編輯器開啟 `.env`，填入以下內容：

```env
# Claude API Key（主要 AI 引擎，向 Anthropic 申請）
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx

# Session 加密金鑰（任意 32 字元以上的隨機字串）
SESSION_SECRET=請替換成隨機字串例如abc123xyz789def456

# 檔案保留天數（預設 30 天後自動清除）
FILE_RETENTION_DAYS=30
```

> 如果沒有 Claude API Key，也可以改用 Gemini（見[環境變數說明](#環境變數說明)）。

### 步驟三：啟動服務

```bash
docker compose up -d --build
```

首次執行會下載並建置 Docker image，約需 **5～15 分鐘**（視網路速度）。

### 步驟四：確認服務狀態

```bash
docker compose ps
```

看到三個服務都是 `running` 即表示成功：

```
NAME                      STATUS
warning-checker-app       running
warning-checker-nginx     running
warning-checker-ollama    running
```

### 步驟五：開啟瀏覽器

前往 **http://localhost:3005**

預設帳號密碼：
- 帳號：`admin`
- 密碼：`admin1234`

> **⚠️ 請立即登入後至「使用者管理」修改預設密碼！**

---

## 環境變數說明

所有設定都在 `.env` 檔案中。

| 變數名稱 | 必填 | 說明 |
|---------|------|------|
| `ANTHROPIC_API_KEY` | 使用 Claude 時必填 | 從 [console.anthropic.com](https://console.anthropic.com) 取得 |
| `SESSION_SECRET` | 必填 | Session 加密用，請填入 32 字元以上的隨機字串 |
| `FILE_RETENTION_DAYS` | 選填 | 上傳檔案保留天數，預設 `30` |
| `LLM_PROVIDER` | 選填 | AI 引擎：`claude`（預設）、`gemini`、`ollama` |
| `GEMINI_API_KEY` | 使用 Gemini 時必填 | 從 Google AI Studio 取得 |
| `GEMINI_MODEL` | 選填 | Gemini 模型，預設 `gemini-2.5-flash` |
| `OLLAMA_MODEL` | 選填 | Ollama 模型，預設 `qwen2.5:7b` |

### 切換 AI 引擎

**使用 Claude（推薦）：**
```env
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```

**使用 Gemini：**
```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=AIzaSyxxxxxxxx
```

**使用 Ollama（本機，不需 API Key）：**
```env
LLM_PROVIDER=ollama
```
切換為 Ollama 後，需要額外下載模型（見[常見問題](#常見問題)）。

---

## 第一次登入與初始設定

登入後建議依序完成以下設定：

### 1. 修改管理員密碼
「管理」→「使用者管理」→ 點選 `admin` → 修改密碼

### 2. 建立使用者帳號
「管理」→「使用者管理」→「新增使用者」

### 3. 設定檢查項目
「管理」→「檢查項目」— 系統已內建基本檢查規則，可依公司規範新增或調整

### 4. 設定基金警語
「管理」→「基金警語」— 建立各基金的加注文字與綜合警語

### 5. 建立基金資料
「管理」→「基金管理」— 建立基金名稱與成立日期，供 AI 判斷績效揭露適用性

---

## 專案架構說明

```
warning-checker/
├── server.js                 # Express 應用程式進入點、路由掛載
├── docker-compose.yml        # Docker 服務定義（app + ollama + nginx）
├── Dockerfile                # Node.js 應用程式容器（含 LibreOffice、Tesseract）
├── nginx.conf                # Nginx 反向代理設定
├── .env.example              # 環境變數範本
│
├── db/
│   ├── migrate.js            # 資料庫 Schema 定義與自動遷移
│   └── seed.js               # 初始資料（預設帳號）
│
├── lib/
│   ├── checker/
│   │   ├── index.js          # 檢查流程主控（協調 auto + AI + 視覺檢查）
│   │   ├── auto.js           # 程式規則檢查（關鍵字、文字比對、格式）
│   │   └── ai.js             # AI 檢查（Claude / Gemini / Ollama）
│   ├── extractor.js          # 文件文字與結構擷取（PDF / DOCX / PPTX）
│   ├── annotator.js          # 在原始文件標注違規位置
│   ├── converter.js          # 文件格式轉換（LibreOffice）
│   ├── report.js             # 產出填寫完成的 Word 檢查表
│   ├── normalizer.js         # 中文文字正規化（全半形、標點符號）
│   ├── ad-types.js           # 廣告類型定義
│   ├── settings.js           # 系統設定讀取
│   └── datetime.js           # 日期格式輔助
│
├── routes/
│   ├── auth.js               # 登入 / 登出
│   ├── upload.js             # 檔案上傳與非同步檢查觸發
│   ├── results.js            # 檢查結果頁面與檔案下載
│   ├── history.js            # 歷史記錄
│   └── admin/
│       ├── check-items.js    # 檢查項目 CRUD
│       ├── fund-warnings.js  # 基金警語 CRUD
│       ├── funds.js          # 基金管理 CRUD
│       ├── users.js          # 使用者管理 CRUD
│       └── settings.js       # 系統設定
│
├── views/                    # EJS 前端模板
│   ├── index.ejs             # 上傳頁面
│   ├── result.ejs            # 檢查結果頁面
│   ├── history.ejs           # 歷史記錄頁面
│   ├── login.ejs             # 登入頁面
│   ├── admin/                # 管理後台頁面
│   └── partials/             # 共用 header / footer
│
├── data/
│   ├── db/
│   │   ├── checker.db        # 主資料庫（SQLite）
│   │   └── sessions.db       # Session 資料庫
│   └── checklist_template.docx  # 檢查表 Word 範本
│
├── uploads/                  # 上傳的原始文件（暫存）
└── outputs/                  # 產出的結果檔案（檢查表 + 標注文件）
```

---

## 功能說明

### 檢查流程

使用者上傳文件後，系統在背景依序執行：

```
上傳文件
   ↓
轉換為 PDF（LibreOffice）
   ↓
擷取文字與結構（pdf-parse + mammoth + Tesseract OCR）
   ↓
多模態圖片文字辨識（AI Vision，擷取圖片內的文字）
   ↓
程式規則檢查（auto）— 不需 AI，毫秒級完成
   ↓
AI 合規檢查（Claude / Gemini / Ollama）— 每個項目獨立呼叫
   ↓
視覺版面檢查（AI Vision，核對警語粗體／字級／位置）
   ↓
標注違規位置（在原始文件標上紅色批注）
   ↓
產出填寫完成的 Word 檢查表
   ↓
完成，通知使用者可下載
```

### 支援的文件格式

| 格式 | 說明 |
|------|------|
| `.docx` / `.doc` | Word 文件，可核對粗體、字級等格式 |
| `.pptx` / `.ppt` | PowerPoint 簡報，最常用 |
| `.pdf` | PDF，文字型或掃描型（掃描型會自動 OCR）|

### 檢查項目類型

每個檢查項目可設定：

**適用性判斷**（何時執行此檢查）
- **一律適用** — 每份文宣都執行
- **由 AI 判斷** — AI 判斷文宣是否符合適用前提
- **文宣出現特定文字才適用** — 觸發關鍵字命中才執行

**合規性判斷**（如何判定是否合規）
- **由 AI 判斷** — AI 依設定的標準評估
- **文宣必須包含特定警語文字** — 程式直接比對文字是否存在

---

## 管理後台說明

### 檢查項目（`/admin/check-items`）

定義每一條需要核對的合規規則。

- **類別**：用於分組顯示（例：基金績效及業績數字之表達）
- **主描述**：此序號的檢查說明
- **適用廣告類型**：僅對勾選的廣告類型執行
- **子檢查項目**：同一序號可拆成多個獨立子項，各自設定適用性與合規標準

### 基金警語（`/admin/fund-warnings`）

定義各基金名稱出現時，必須同時出現的加注文字與警語。

- 可設定「緊接基金名稱之後」、「全文任意處」、「同一頁」、「文宣最後」等位置規則
- 可設定警語的格式要求（粗體、顯著顏色、字級等）

### 基金管理（`/admin/funds`）

建立基金名稱與成立日期。

- 系統自動計算成立年齡
- AI 檢查時會讀取此資料，從文宣辨識對應基金，判斷是否符合績效揭露資格（成立未滿一年不得揭露績效）

### 使用者管理（`/admin/users`）

- 建立一般使用者帳號
- 管理員（admin）可存取所有管理功能，一般使用者只能上傳與查看自己的結果

### 系統設定（`/admin/settings`）

- **AI 系統提示詞**：調整 AI 的角色設定與判斷基準

---

## 日常維護

### 停止服務
```bash
docker compose down
```

### 重新啟動
```bash
docker compose up -d
```

### 更新程式碼後重新部署
```bash
git pull
docker compose up -d --build
```

### 查看應用程式 Log
```bash
docker compose logs app -f
```

### 手動清除過期檔案
```bash
docker compose exec app node scripts/cleanup.js
```

### 備份資料庫
```bash
# 複製整個 data/db/ 目錄即可
cp -r data/db/ backup/db-$(date +%Y%m%d)/
```

---

## 常見問題

### Q：使用 Ollama 時，AI 完全沒有回應？

需要先下載語言模型：

```bash
docker compose exec ollama ollama pull qwen2.5:7b
```

下載完成後（約 4-5 GB），重新上傳文件即可。

### Q：轉換 PDF 失敗，錯誤訊息提到 LibreOffice？

重建容器：
```bash
docker compose up -d --build
```

### Q：掃描型 PDF 沒有辨識出文字（OCR 失敗）？

確認容器內 Tesseract 已安裝：
```bash
docker compose exec app tesseract --version
```

若輸出正常，可能是圖片解析度過低，建議要求上傳方提供文字型 PDF 或解析度 150 DPI 以上的掃描檔。

### Q：如何修改服務對外的 Port？

編輯 `docker-compose.yml`，修改 nginx 的 ports：
```yaml
ports:
  - "你想要的Port:80"
```
再執行 `docker compose up -d`。

### Q：忘記 admin 密碼怎麼辦？

```bash
docker compose exec app node -e "
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('./data/db/checker.db');
const hash = bcrypt.hashSync('新密碼', 10);
db.prepare(\"UPDATE users SET password_hash=? WHERE username='admin'\").run(hash);
console.log('密碼已重設');
db.close();
"
```

---

## 技術棧

| 層次 | 技術 |
|------|------|
| 後端框架 | Node.js + Express 4 |
| 資料庫 | SQLite（better-sqlite3） |
| 前端模板 | EJS + Bootstrap 5 |
| 文件轉換 | LibreOffice（headless） |
| 文字擷取 | pdf-parse、mammoth、Tesseract OCR |
| AI 引擎 | Claude（Anthropic）/ Gemini（Google）/ Ollama（本機） |
| 容器化 | Docker + Docker Compose |
| 反向代理 | Nginx |
