---
name: vrchat-asset-importer
description: >
  Import a Booth (booth.pm) VRChat asset page into the Notion
  "模型資源整理" database. Auto-extracts Name, 類型 (服裝/髮型),
  thumbnail, URL, 價格 (Full Pack preferred, else max variation),
  and matches 適用於 avatars from description/tags/variations.
  Re-running on the same URL updates the existing page in place.
  Trigger when user shares a booth.pm /items/ URL and asks to add
  it to the asset database, or says things like:
  "加進模型資源整理", "加入 VRChat 資料庫", "import this booth item",
  "新增 VRChat 服裝/髪型".
---

# vrchat-asset-importer

Import one Booth item → Notion `模型資源整理` DB (`1e86282d-955a-8052-99e4-d25fd6b6e49e`).
Booth only. Other sources (gumroad / pixiv / jingo / etc.) are not supported in v1.

## TL;DR for agents

When user pastes a booth.pm URL and wants it added to the asset DB:

```bash
# Step 1 — see what gets extracted
node <SKILL_DIR>/scripts/import.mjs <booth_url> --dry-run

# Step 2 — write (auto-detect 可用於同人製作 may stay blank)
node <SKILL_DIR>/scripts/import.mjs <booth_url>

# Step 3 — if dry-run shows licenseUrls but no auto decision:
#   - WebFetch the JP Drive PDF (see "Tier B" section below for the URL trick + pypdf extraction)
#   - find the "R." row, then commit:
node <SKILL_DIR>/scripts/import.mjs <booth_url> --doujin allow|inquire|prohibit
```

Re-running on the same URL **updates in place**, so it's safe to iterate.

If a field comes out wrong, the fix is almost always **add a keyword to a table inside `scripts/import.mjs`** — see "漏判處理（LLM 工作流）" section. Never edit the logic.

## Requirements

- **Node 18+** (for built-in `fetch`)
- **Network**: outbound to `booth.pm`, `booth.pximg.net`, `api.notion.com`
- **Notion token**: read from `$NOTION_API_KEY` or `~/.openclaw/openclaw.json` `skills.entries.notion.env.NOTION_API_KEY`
- **Notion integration must be Connected** to the target DB
- **(Optional, for Tier B VN3 PDF parsing)** `python3` + `pypdf`. If absent, agent must either install `pip3 install pypdf` (or `brew install poppler` for `pdftotext` as alternative), or fall back to asking the user.

## Usage

```bash
node <SKILL_DIR>/scripts/import.mjs <booth_url>
node <SKILL_DIR>/scripts/import.mjs <booth_url> --dry-run
node <SKILL_DIR>/scripts/import.mjs <booth_url> --doujin allow|inquire|prohibit|clear
```

- No flag → create if URL not in DB, otherwise update in place.
- `--dry-run` → print extracted fields + Notion payload + doujin evidence; no API write.
- `--doujin <value>` → 強制設定「可用於同人製作」欄位（LLM 看完 VN3 規約後使用）。`clear` 會清空。

`<SKILL_DIR>` is where this skill is installed, e.g.:
- openclaw: `~/.openclaw/skills/vrchat-asset-importer/`
- hermes: `~/.hermes/skills/openclaw-imports/vrchat-asset-importer/` (or wherever the host imports it)

## What gets filled

| Notion 欄位 | 來源 | 規則 |
|---|---|---|
| Name | `name` | 原文（保留 emoji / 促銷前綴） |
| 類型 | `category.name` → tags | `3D衣装` → `服裝`；含「髪/髮/Hair」→ `髮型`；不確定 → **留空**（不亂猜） |
| Files & media | `images[0].original` | 第一張預覽圖；以 external URL 形式寫入。影片在 `embeds` 不會混進來 |
| URL | `data.url` | 正規化後的 booth URL（不是使用者輸入的） |
| 價格 | `variations[]` | ① 找 name 含 FULL PACK / フルパック / フルセット / Full Set → ② 否則取 max variation price → ③ fallback top-level `price` 解析 |
| Full Set | 同上 | 命中 ① 時 → 勾選；**永遠不會自動取消**（避免覆蓋使用者手動標記） |
| 特價 | name + description | 命中 `\d+%OFF` / `半額` / `セール` / `SALE` / `割引` / `特価` / `大感謝` / `キャンペーン` → 勾選；否則取消（booth 是 source of truth） |
| 特價至 | description | 解析日期區間 `2026.05.20〜06.20まで` / `2026.6.20まで` / `2026/5/20〜2026/6/20` → 取結束日；沒命中 → 清空 |
| 適用於 | description + variations[].name + tags[].name | 對 14 個 DB 選項用中/日/英/韓別名表比對 |
| 可用於同人製作 | description + 利用規約段落 + VN3 PDF（透過 LLM WebFetch） | 三層流程，見下節 |
| 其他欄位 | — | 不動（已購買 / 購買日期 / 購買價格 / 購物車 由使用者手動維護） |

## 重複處理

- 以 `URL` 欄位為鍵 query DB
- 命中 → PATCH 該頁面（覆蓋本 skill 管理的 6 個欄位，**不會清掉** 使用者手填的「已購買 / 購買日期 / 同人製作 / 購物車」等）
- 沒命中 → POST 新頁

## 認證

讀取順序：`$NOTION_API_KEY` → `~/.openclaw/openclaw.json` 的 `skills.entries.notion.env.NOTION_API_KEY`

無需額外設定。若 token 失效，到 [Notion integrations](https://www.notion.so/profile/integrations) 換新後更新 openclaw.json。

DB 必須對該 integration **Connect**（已確認可讀寫）。

## 範例

```bash
$ node ~/.openclaw/skills/vrchat-asset-importer/scripts/import.mjs \
    https://isekaisuzuya.booth.pm/items/7910491 --dry-run
=== extracted ===
{
  "name": "😇4周年50％OFF😇【14アバター対応】ササメキSasameki🔪",
  "type": "服裝",
  "thumbnail": "https://booth.pximg.net/.../eca18880-...jpg",
  "url": "https://isekaisuzuya.booth.pm/items/7910491",
  "price": 1500,
  "isFullPack": true,
  "onSale": true,
  "saleEndDate": "2026-06-20",
  "avatars": ["愛莉", "MANUKA", "Eku", "Milfy", "クマリ"]
}
```

## 可用於同人製作（三層流程）

這個欄位很難純粹用關鍵字判斷，因此設計成「script 蒐證 → LLM 判讀 → script 寫入」的協作流程。

### Tier A — 描述含明確關鍵字（script 自動填）

腳本在 `name + description + 利用規約段落` 找 `DOUJIN_ALLOW_KEYWORDS / DOUJIN_PROHIBIT_KEYWORDS / DOUJIN_INQUIRE_KEYWORDS`，優先順序 prohibit > inquire > allow（保守判斷）。命中即寫入，不需 LLM。

### Tier B — 頁面附 VN3 license 連結（LLM 用 WebFetch 看 R 欄）

booth 的「利用規約」段落（位於 HTML `<section class="shop__text">` 中）若含 Google Drive / Docs / PDF / Notion 連結，腳本會在 dry-run 輸出 `licenseUrls`，並提示 LLM：

> R 欄全文：「将该数位文件作为特定商用产品等电子软件的一部分」（ZH）  
> JP 等價說法：「製品開発等のためにソフトウェア（ゲームを含みます）へ組み込み」  
> EN 等價說法：「Incorporating ... as part of commercial products such as electronic software」

#### LLM 抓 Drive PDF 的標準流程

Drive 的 `/file/d/.../view` URL **不能直接 WebFetch**（會被導向登入頁），要改用下載 URL：

```
https://drive.google.com/file/d/<FILE_ID>/view?usp=sharing
  ↓ 轉換
https://drive.google.com/uc?export=download&id=<FILE_ID>
  ↓ WebFetch 會回 redirect 到
https://drive.usercontent.google.com/download?id=<FILE_ID>&export=download
```

PDF 多半是**圖片型**（VN3 表格用 ○△✕ 圖示），WebFetch 看不到內文。Drive 下載完的 PDF 會被存到 tool-results 目錄，用 `pypdf` 抽文字。

**pypdf 未安裝**：先 `pip3 install pypdf`。若無法安裝，fallback 是 `brew install poppler` 然後改用 `pdftotext -layout "$PDF" - | grep -A1 "R\\."`；兩者都失敗就直接告知主人並設 `--doujin inquire`（保守）。

```bash
PDF="<path from WebFetch result>"
python3 -c "
import pypdf, re
r = pypdf.PdfReader('$PDF')
text = '\n'.join((p.extract_text() or '') for p in r.pages)
# pypdf 對 CJK 會插空白，要壓縮
text = re.sub(r'(?<=[^\x00-\x7f])\s+(?=[^\x00-\x7f])', '', text)
text = re.sub(r'\s+', ' ', text)
# 找 R 列
for m in re.finditer(r'(?<![A-Za-z])R[\.\s]', text):
    s = max(0, m.start()-30); e = min(len(text), m.end()+250)
    print(text[s:e])
    print('---')
"
```

R 欄結果 → 寫回 Notion：

| PDF 文字 | flag |
|---|---|
| 許可します / 許可 / ○ | `--doujin allow` |
| 権利者に個別に問い合わせて下さい / 要相談 / △ | `--doujin inquire` |
| 許可しません / 不許可 / 禁止 / ✕ | `--doujin prohibit` |

優先抓 JP 版（多半最詳細、最權威）。其他語版若 JP 失敗才用。

### Tier C — 外部規約頁面 / 描述需判讀（LLM WebFetch + 自行判斷）

頁面沒 VN3 但有其他連結（作者個人頁、FANBOX、自製規約頁），或描述含「同人ゲーム等への利用については…」這類含糊敘述：LLM 直接用 WebFetch 抓相關連結 / 細讀描述後決定。

**判斷準則（主人確認過）**：以下任一條成立就一律寫 `--doujin inquire`，**不要試著做寬鬆解讀**：

1. 描述用條件式語句（「個人的な用途に限り」「私的利用の範囲で」等）來限定商用範圍
2. 同一頁的 JP / EN / KO / ZH 描述語意不一致（例如 JP 列出「ゲーム」但 EN 只說 personal use）
3. 作者明文要求「個別問い合わせ / 要相談 / DM ください」
4. 描述只覆蓋部分用途（如 VTubing OK），對「嵌入販售型 build」沒明確表態

只有當作者**明確、無條件地**寫「ゲーム使用OK / 同人ゲーム OK / 商業利用可」這類陳述時才寫 `--doujin allow`。

### Tier D — 完全無線索

腳本**留空**該欄位（不亂猜，**不會覆蓋使用者手填值**）。可問主人是否仍要標記。

### 衝突處理

- 自動判斷與 LLM 判讀**衝突時，LLM 用 `--doujin <value>` 覆蓋**（override 必勝）
- 使用者已手動填好、不想被覆蓋 → 先跑 `--dry-run` 把要寫入的 payload 列出來比對，再決定要不要正式跑
- 想清掉錯誤的標記 → `--doujin clear`

## 漏判處理（LLM 工作流）

腳本的判斷靠**關鍵字表**，新角色 / 新促銷詞 / 新類別 一定會漏。**LLM 看到 dry-run 結果有欄位空著或明顯錯誤時，照下面流程處理。**

### 大原則
1. **只新增關鍵字字串到 `scripts/import.mjs` 上半部標記為 `KEYWORD TABLES` 的表格內**
2. **絕不修改**該檔案 `LOGIC` 區塊以下的任何函數內容、regex、控制流
3. 改完一定要 `--dry-run` 一次確認新關鍵字確實命中再正式跑
4. **判斷不出來就告知主人，不要亂猜**（誤判 avatar / 類型比留空更糟）

### 對照表：欄位漏判 → 改哪個表格

| 漏判欄位 | 表格 | 例子 |
|---|---|---|
| `適用於` 少了某個 avatar | `AVATAR_ALIASES['<canonical>']` | 頁面寫「あいりちゃん」沒命中 → push `'あいり'` 到 `AVATAR_ALIASES['愛莉']` |
| `類型` = null（明顯是服裝/髮型） | `TYPE_KEYWORDS['服裝'].category` 或 `.tags`（髮型同理） | booth category 是「3Dアクセサリー > 髪飾り」→ push `'髪飾り'` 到 `TYPE_KEYWORDS['髮型'].tags` |
| `onSale` = false 但頁面在打折 | `SALE_KEYWORDS` | 頁面寫「年末プロモーション」→ push 進 `SALE_KEYWORDS` |
| `isFullPack` = false 但確實有 full pack | `FULL_PACK_KEYWORDS` | variation 叫「オールインワン」→ push 進 `FULL_PACK_KEYWORDS` |
| `doujin` 描述明明寫了立場卻沒命中 | `DOUJIN_ALLOW_KEYWORDS` / `DOUJIN_PROHIBIT_KEYWORDS` / `DOUJIN_INQUIRE_KEYWORDS` | 描述寫「個人ゲーム制作可」→ push 進 ALLOW；「ゲーム化はDM要相談」→ push 進 INQUIRE |
| `licenseUrls` 沒抓到（明明頁面有 VN3 連結） | — | terms section 標題不在 `TERMS_SECTION_HEADINGS`（例如作者寫「ご利用について」）→ push 進該表 |

### 不能用加關鍵字解決的情況（→ 告知主人）

- **`saleEndDate` = null 但 `onSale` = true** → 日期格式 parser 沒涵蓋，這是 *logic* 不是 *keyword*。把頁面用的日期寫法（例如 `2026年5月20日まで` / `until June 20` / `~ 6/20`）回報主人，**不要自己改 `parseSaleEndDate`**
- **`類型` 該歸 服裝 還是 髮型 兩可**（例如帽子＋頭髮一體）→ 留空，問主人
- **`適用於` 找不到對應的 canonical**（avatar 不在 14 個選項裡）→ 留空，問主人是否要新增 DB 選項
- **頁面語言 / 結構特殊**（影片頁面、套裝頁面、改修紀錄頁面而非商品頁）→ 留空相關欄位，回報

### LLM 修改範例

```diff
 const AVATAR_ALIASES = {
   '萌':        ['萌', 'もえ', 'Moe'],
-  '愛莉':      ['愛莉', 'Airi', 'アイリ', '아이리'],
+  '愛莉':      ['愛莉', 'Airi', 'アイリ', '아이리', 'あいり', 'Airi-chan'],
   'SELESTIA':  ['SELESTIA', 'Selestia', 'セレスティア', '셀레스티아'],
```

僅在表格陣列內加字串，不動其他結構。

### 偵錯用：看原始 Booth JSON

```bash
curl -s -A "Mozilla/5.0" 'https://<shop>.booth.pm/items/<id>.json' | python3 -m json.tool | less
```

特別有用的欄位：`category.name`、`tags[].name`、`variations[].name`、`description`（前 500 字通常就有促銷資訊）。

## 已知限制

- 僅 booth.pm `/items/<id>` URL
- `特價至` 日期 parser 僅支援 `YYYY.MM.DD〜MM.DD[まで]` / `YYYY.MM.DD〜YYYY.MM.DD` / `YYYY.MM.DDまで` 三類，其他格式需主人擴充
- 若 DB schema 改了選項名（例如 `服裝` 改成 `衣裝`），需同步改腳本對應字串，否則 Notion 會回 400
- 不處理多頁面 / 批次匯入（一次一個 URL）
