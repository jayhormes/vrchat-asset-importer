# vrchat-asset-importer

> An openclaw / hermes / Claude Code skill that imports a [Booth](https://booth.pm) VRChat asset page into a Notion database — in one command.

Given a Booth item URL, this skill auto-extracts product info and writes a fully-tagged row to the Notion `模型資源整理` database, including a 3-tier flow for the tricky `可用於同人製作` (doujin usage) field that involves parsing VN3 license PDFs.

## What it fills

| Notion 欄位 | 來源 | Notes |
|---|---|---|
| Name | booth `name` | |
| 類型 | `category.name` → tags | `服裝` / `髮型` |
| Files & media | first preview image | external URL |
| URL | normalized booth URL | |
| 價格 | variations | FULL PACK preferred, else max |
| Full Set | FULL PACK variation match | only sets `true`, never unticks |
| 特價 / 特價至 | description scan | overwritten on every run |
| 適用於 | description + tags + variations | multi-language alias table |
| 可用於同人製作 | 3-tier: keyword → VN3 R-column → external link | see [SKILL.md](./SKILL.md) |

Re-running on the same URL **updates in place** (matched by URL).

## Install

### openclaw

```bash
git clone https://github.com/jayhormes/vrchat-asset-importer.git \
  ~/.openclaw/skills/vrchat-asset-importer
# Token is auto-read from ~/.openclaw/openclaw.json
#   skills.entries.notion.env.NOTION_API_KEY
```

### hermes

```bash
git clone https://github.com/jayhormes/vrchat-asset-importer.git \
  ~/.hermes/skills/openclaw-imports/vrchat-asset-importer
export NOTION_API_KEY=ntn_...   # or add to hermes' env management
```

### Anywhere (Claude Code / generic agent)

```bash
git clone https://github.com/jayhormes/vrchat-asset-importer.git
export NOTION_API_KEY=ntn_...
node ./vrchat-asset-importer/scripts/import.mjs <booth_url> --dry-run
```

## Usage

```bash
# Preview what will be written (no API call)
node <SKILL_DIR>/scripts/import.mjs https://booth.pm/zh-tw/items/4590436 --dry-run

# Create (or update if URL already in DB)
node <SKILL_DIR>/scripts/import.mjs https://booth.pm/zh-tw/items/4590436

# Override 可用於同人製作 (after reading VN3 license PDF)
node <SKILL_DIR>/scripts/import.mjs <url> --doujin allow|inquire|prohibit|clear
```

## Requirements

- **Node 18+** (for built-in `fetch`)
- **Notion integration**, Connected to the target DB, with read/write
- **(Optional, for Tier B VN3 PDF parsing)** `python3` + `pypdf`
  - Fallback: `brew install poppler` (provides `pdftotext`)
  - Both unavailable → script outputs `licenseUrls`; agent should ask the user

## For agents picking this up

The full LLM workflow lives in [SKILL.md](./SKILL.md). Key points:

1. **Always start with `--dry-run`.** Output shows extracted fields + Notion payload + doujin evidence (matched keywords, VN3 license URLs, terms text excerpt).
2. **If a field is missing**, the fix is almost always **add a string to a keyword table** at the top of [`scripts/import.mjs`](./scripts/import.mjs). Never edit the logic functions below the `LOGIC` divider.
3. **For VN3 license PDFs** (Tier B), use `https://drive.google.com/uc?export=download&id=<FILE_ID>` (not `/view`), then `pypdf` to extract row R. See SKILL.md § "LLM 抓 Drive PDF 的標準流程".
4. **When ambiguous**, write `--doujin inquire` (the conservative default) rather than guessing `allow`. The 4 ambiguity triggers are listed in SKILL.md § "Tier C".

## Customization

This skill is hardcoded to one specific Notion DB schema (`1e86282d-955a-8052-99e4-d25fd6b6e49e`) and 14 avatar options. To adapt for your own DB:

1. Update `NOTION_DB_ID` in `scripts/import.mjs`
2. Update `AVATAR_ALIASES` to match your DB's `適用於` multi-select options
3. Verify the property names match your schema (Name, URL, 類型, 價格, 特價, etc.)

## License

Personal tool. No warranty. Fork freely.
