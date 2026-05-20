#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NOTION_DB_ID = '1e86282d-955a-8052-99e4-d25fd6b6e49e';
const NOTION_VERSION = '2022-06-28';

// ─────────────────────────────────────────────────────────────────
//  KEYWORD TABLES
//
//  LLM 可以新增條目到下面這些表格（例如新角色別名、新促銷詞）。
//  ⚠ 不要修改下方 logic 函數的內容 — 只在表格裡加字串。
//  改完務必跑 --dry-run 驗證命中再正式 update。
// ─────────────────────────────────────────────────────────────────

// 「適用於」候選 avatar 與其各語別名。Key = Notion DB 的 multi_select 選項名。
const AVATAR_ALIASES = {
  '萌':        ['萌', 'もえ', 'Moe'],
  '愛莉':      ['愛莉', 'Airi', 'アイリ', '아이리'],
  'SELESTIA':  ['SELESTIA', 'Selestia', 'セレスティア', '셀레스티아'],
  'MANUKA':    ['MANUKA', 'Manuka', 'マヌカ', '마누카'],
  '海咲':      ['海咲', 'Misaki', 'みさき'],
  'Cazalis':   ['Cazalis', 'カザリス'],
  '桔梗':      ['桔梗', 'Kikyou', 'ききょう'],
  '舞夜':      ['舞夜', 'Maya', 'まよ'],
  'Eku':       ['Eku', 'eku', 'エク', '에쿠'],
  'Milfy':     ['Milfy', 'milfy', 'ミルフィ', '밀피'],
  'ゾメちゃん': ['ゾメ', 'Zome'],
  'クマリ':    ['クマリ', 'Kumaly', 'kumaly', '쿠마리'],
  'Iris':      ['Iris', 'iris', 'アイリス'],
  '狐雪':      ['狐雪', 'Kitsuneyuki'],
};

// 「類型」判斷：先比 booth category.name，再 fallback 到 tags。
// Key = Notion DB 的 select 選項名（目前只填 服裝 / 髮型，其他類型留空待人工處理）。
const TYPE_KEYWORDS = {
  '服裝': {
    category: ['衣装', '衣裝'],
    tags:     ['衣装', '衣裝', 'ドレス', 'dress', 'outfit', 'costume'],
  },
  '髮型': {
    category: ['髪', '髮', 'ヘア', 'hair'],
    tags:     ['髪', '髮', 'ヘア', 'hair', 'ヘアスタイル'],
  },
};

// 命中即「Full Set + 價格 = 該 variation」。比對對象是 variations[].name（不分大小寫）。
const FULL_PACK_KEYWORDS = [
  'FULL PACK', 'FULLPACK', 'FULL_PACK',
  'フルパック', 'フルセット', 'フル パック',
  'Full Set', 'FullSet',
];

// 「特價」判斷：在 name + description 做 substring 比對（不分大小寫）。
// 結構性 pattern「<數字>%OFF」是另外用 regex 處理（在 parseSaleInfo 內），不放這裡。
const SALE_KEYWORDS = [
  '半額', 'セール', 'SALE', '割引', '特価', '特價',
  '大感謝', 'キャンペーン',
];

// 「可用於同人製作」自動判斷的關鍵字。
// 優先順序：prohibit > inquire > allow（保守判斷，「禁止」最強）。
// 含糊用語（如單獨出現的「ご相談ください」）放 inquire，不要放 allow。
const DOUJIN_ALLOW_KEYWORDS = [
  '商用利用OK', '商用利用可', '商用OK',
  'ゲーム制作可', 'ゲーム使用可', 'ゲーム制作OK', 'ゲーム使用OK',
  '同人ゲーム使用可', '同人OK', '同人利用OK',
  '自作ゲームに使用可', '商業利用可',
];
const DOUJIN_PROHIBIT_KEYWORDS = [
  '商用利用不可', '商用利用禁止', '商用利用を禁止', '商用NG',
  'ゲーム使用禁止', 'ゲーム制作禁止', 'ゲーム使用不可',
  '同人禁止', '同人ゲーム禁止',
  '商業利用禁止', '商業利用不可', '商業利用を禁止',
];
const DOUJIN_INQUIRE_KEYWORDS = [
  '商用利用は要問合せ', '商用は要相談', '商用利用は要相談',
  'ゲーム使用は要問合せ', 'ゲーム使用は要相談',
  '商業利用は要問合せ',
];

// 「利用規約」段落的 <h2> 標題判斷（HTML 內 <section class="shop__text"> 多段）。
// 命中其一即視為 terms section。
const TERMS_SECTION_HEADINGS = [
  '利用規約', '利用条款', '使用条款', '使用條款',
  '規則', 'Rules', 'Rule',
  'ライセンス', 'License', 'Terms of use', 'Terms of Use', 'TOS',
  '이용규약',
];

// ─────────────────────────────────────────────────────────────────
//  LOGIC — 以下函數本體請勿讓 LLM 修改。
// ─────────────────────────────────────────────────────────────────

const DOUJIN_OVERRIDE_MAP = { allow: '允許', inquire: '徵詢', prohibit: '禁止' };

function parseArgs(argv) {
  const args = { url: null, dryRun: false, doujinOverride: undefined, noVN3Auto: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--no-vn3-auto') args.noVN3Auto = true;
    else if (a === '--doujin') {
      const v = rest[++i];
      if (!['allow', 'inquire', 'prohibit', 'clear'].includes(v)) {
        die(`--doujin must be allow|inquire|prohibit|clear (got: ${v})`);
      }
      args.doujinOverride = v;
    }
    else if (!args.url) args.url = a;
  }
  return args;
}

function usage() {
  console.log(`usage: import.mjs <booth_url> [--dry-run] [--doujin <value>] [--no-vn3-auto]

  <booth_url>          e.g. https://isekaisuzuya.booth.pm/items/7910491
  --dry-run            print extracted fields + Notion payload + doujin evidence, no write
  --doujin <value>     force 可用於同人製作 = allow|inquire|prohibit|clear (overrides auto-detect)
  --no-vn3-auto        skip the VN3 PDF auto-extraction step (use when offline / pypdf missing)

env:
  NOTION_API_KEY  Notion integration token (fallback: openclaw.json)

VN3 auto-extraction requires: python3 + pypdf  (pip3 install pypdf)
`);
}

function die(msg, code = 1) {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

function readToken() {
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY;
  try {
    const p = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    return cfg?.skills?.entries?.notion?.env?.NOTION_API_KEY || null;
  } catch { return null; }
}

function isBoothUrl(s) {
  try {
    const u = new URL(s);
    return /(^|\.)booth\.pm$/.test(u.hostname) && /\/items\/\d+/.test(u.pathname);
  } catch { return false; }
}

function toJsonUrl(s) {
  const u = new URL(s);
  u.search = ''; u.hash = '';
  let p = u.pathname.replace(/\/+$/, '');
  if (!p.endsWith('.json')) p += '.json';
  u.pathname = p;
  return u.toString();
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'User-Agent': 'Mozilla/5.0 vrchat-asset-importer',
      'Accept': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${body.slice(0, 500)}`);
  }
  return res.json();
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'User-Agent': 'Mozilla/5.0 vrchat-asset-importer',
      'Accept': 'text/html,application/xhtml+xml',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function stripTags(s) { return s.replace(/<[^>]+>/g, ''); }
function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function extractTermsSection(html) {
  if (!html) return null;
  const sectionRe = /<section\s+class="[^"]*\bshop__text\b[^"]*"[^>]*>([\s\S]*?)<\/section>/g;
  const sections = [];
  let m;
  while ((m = sectionRe.exec(html)) !== null) {
    const inner = m[1];
    const h2 = inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const p  = inner.match(/<p[^>]*\bjs-autolink\b[^>]*>([\s\S]*?)<\/p>/);
    if (!h2 || !p) continue;
    const title = decodeHtml(stripTags(h2[1])).trim();
    const text  = decodeHtml(stripTags(p[1])).trim();
    sections.push({ title, text });
  }
  const isTerms = t => TERMS_SECTION_HEADINGS.some(h => t.toLowerCase().includes(h.toLowerCase()));
  return sections.find(s => isTerms(s.title))?.text || null;
}

function extractLicenseUrls(text) {
  if (!text) return [];
  const urls = text.match(/https?:\/\/[^\s)（）<>"'、，。]+/g) || [];
  // license-document hosts that LLM should WebFetch
  return [...new Set(urls.filter(u =>
    /drive\.google\.com\/file\//.test(u) ||
    /docs\.google\.com\/(document|spreadsheets|presentation)\//.test(u) ||
    /\.pdf(\?|$)/i.test(u) ||
    /notion\.so\//.test(u) ||
    /notion\.site\//.test(u)
  ))];
}

function parseDoujinInfo(data, html) {
  const termsText = extractTermsSection(html);
  const haystack = [data.name || '', data.description || '', termsText || ''].join('\n');
  const lower = haystack.toLowerCase();

  const hits = {
    allow:    DOUJIN_ALLOW_KEYWORDS.filter(k => lower.includes(k.toLowerCase())),
    prohibit: DOUJIN_PROHIBIT_KEYWORDS.filter(k => lower.includes(k.toLowerCase())),
    inquire:  DOUJIN_INQUIRE_KEYWORDS.filter(k => lower.includes(k.toLowerCase())),
  };
  let decision = null;
  if (hits.prohibit.length) decision = '禁止';
  else if (hits.inquire.length) decision = '徵詢';
  else if (hits.allow.length) decision = '允許';

  return {
    decision,
    keywordHits: hits,
    termsText,
    licenseUrls: extractLicenseUrls(termsText),
  };
}

// ── VN3 auto-extraction (Drive PDF → R-row → 允許/徵詢/禁止) ─────

const VN3_LANG_PATTERNS = {
  jp: /(jp|日本語|規約全文|japanese|ja\b)/i,
  en: /(\ben\b|english|terms\s+of\s+use)/i,
  zh: /(\bzh\b|中文|使用条款|使用條款|chinese)/i,
  ko: /(\bko\b|한국|이용규약|korean)/i,
};
const VN3_LANG_PRIORITY = ['jp', 'en', 'zh', 'ko', 'unknown'];

function detectLang(label) {
  for (const [lang, re] of Object.entries(VN3_LANG_PATTERNS)) {
    if (re.test(label)) return lang;
  }
  return 'unknown';
}

function pickPreferredLicenseUrl(termsText, urls) {
  if (!termsText) return urls[0];
  const tagged = urls.map(url => {
    const idx = termsText.indexOf(url);
    const label = idx < 0 ? '' : termsText.slice(Math.max(0, idx - 100), idx);
    return { url, lang: detectLang(label) };
  });
  tagged.sort((a, b) => VN3_LANG_PRIORITY.indexOf(a.lang) - VN3_LANG_PRIORITY.indexOf(b.lang));
  return tagged[0].url;
}

function driveToDownloadUrl(url) {
  const m = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : url;
}

async function downloadPdfToTemp(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 vrchat-asset-importer' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const ct = res.headers.get('content-type') || '';
  if (!/pdf|octet-stream|binary/i.test(ct)) {
    throw new Error(`unexpected content-type: ${ct} (likely a Drive confirm/auth page, not a PDF)`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = path.join(os.tmpdir(), `vn3-${Date.now()}-${process.pid}.pdf`);
  fs.writeFileSync(dest, buf);
  return { path: dest, bytes: buf.length };
}

async function attemptVN3Auto(termsText, licenseUrls) {
  if (!licenseUrls?.length) return { ok: false, error: 'no license URLs' };
  const url = pickPreferredLicenseUrl(termsText, licenseUrls);
  const downloadUrl = driveToDownloadUrl(url);

  let pdf;
  try {
    pdf = await downloadPdfToTemp(downloadUrl);
  } catch (e) {
    return { ok: false, error: `download failed: ${e.message}`, fromUrl: url };
  }

  const scriptPath = path.join(__dirname, 'extract-vn3.py');
  const result = spawnSync('python3', [scriptPath, pdf.path], { encoding: 'utf-8' });

  // best-effort cleanup
  try { fs.unlinkSync(pdf.path); } catch {}

  if (result.error) {
    return {
      ok: false,
      error: `python3 unavailable: ${result.error.message}`,
      hint: 'install python3, then `pip3 install pypdf`',
      fromUrl: url,
    };
  }
  if (result.status === 2) {
    return { ok: false, error: 'pypdf not installed', hint: 'pip3 install pypdf', fromUrl: url };
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch {
    return {
      ok: false,
      error: `extract-vn3.py output not JSON (exit ${result.status})`,
      stderr: (result.stderr || '').slice(0, 200),
      fromUrl: url,
    };
  }
  if (parsed.error) return { ok: false, error: parsed.error, hint: parsed.hint, fromUrl: url };
  return { ok: true, ...parsed, fromUrl: url, pdfBytes: pdf.bytes };
}

function pickPrice(data) {
  const vars = Array.isArray(data.variations) ? data.variations : [];
  if (vars.length === 0) {
    const m = String(data.price ?? '').match(/(\d[\d,]*)/);
    return { price: m ? parseInt(m[1].replace(/,/g, ''), 10) : null, isFullPack: false };
  }
  const fullPack = vars.find(v => {
    const n = (v.name || '').toUpperCase();
    return FULL_PACK_KEYWORDS.some(k => n.includes(k.toUpperCase()));
  });
  if (fullPack && typeof fullPack.price === 'number') {
    return { price: fullPack.price, isFullPack: true };
  }
  const prices = vars.map(v => v.price).filter(p => typeof p === 'number');
  return { price: prices.length ? Math.max(...prices) : null, isFullPack: false };
}

function parseSaleEndDate(text) {
  // pattern A: full date range  2026.05.20〜(2026.)06.20  (end year optional → inherit start year)
  const rangeRe = /(20\d{2})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})日?\s*[〜～~\-ー至–—]+\s*(?:(20\d{2})[.\-/年]\s*)?(\d{1,2})[.\-/月]\s*(\d{1,2})日?/;
  const r = rangeRe.exec(text);
  if (r) {
    const [, sy, , , ey, em, ed] = r;
    return `${ey || sy}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
  }
  // pattern B: single date with まで / until
  const untilRe = /(20\d{2})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})日?\s*(?:まで|until)/i;
  const u = untilRe.exec(text);
  if (u) {
    const [, y, m, d] = u;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

function parseSaleInfo(data) {
  const text = `${data.name || ''}\n${data.description || ''}`;
  const lowered = text.toLowerCase();
  const onSale =
    /\d+\s*[%％]\s*off/i.test(text) ||
    SALE_KEYWORDS.some(k => lowered.includes(k.toLowerCase()));
  const saleEndDate = onSale ? parseSaleEndDate(text) : null;
  return { onSale, saleEndDate };
}

function pickType(data) {
  const catName = (data.category?.name || '').toLowerCase();
  for (const [type, kw] of Object.entries(TYPE_KEYWORDS)) {
    if (kw.category.some(k => catName.includes(k.toLowerCase()))) return type;
  }
  const tagsStr = (data.tags || []).map(t => (t.name || '').toLowerCase()).join(' ');
  for (const [type, kw] of Object.entries(TYPE_KEYWORDS)) {
    if (kw.tags.some(k => tagsStr.includes(k.toLowerCase()))) return type;
  }
  return null;
}

function pickThumbnail(data) {
  const imgs = Array.isArray(data.images) ? data.images : [];
  const first = imgs.find(i => i.original);
  return first?.original || null;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isAscii = s => /^[\x00-\x7f]+$/.test(s);

function matchAvatars(data) {
  const haystack = [
    data.name || '',
    data.description || '',
    (data.variations || []).map(v => v.name || '').join(' '),
    (data.tags || []).map(t => t.name || '').join(' '),
  ].join('\n');

  const hits = new Set();
  for (const [canonical, aliases] of Object.entries(AVATAR_ALIASES)) {
    for (const alias of aliases) {
      const re = isAscii(alias)
        ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(alias)}(?![A-Za-z0-9])`, 'i')
        : new RegExp(escapeRe(alias));
      if (re.test(haystack)) { hits.add(canonical); break; }
    }
  }
  return [...hits];
}

function buildProperties({ name, type, thumbnail, url, price, avatars, isFullPack, onSale, saleEndDate, doujin, doujinExplicit }) {
  const props = {
    Name: { title: [{ text: { content: name } }] },
    URL: { url },
    '特價': { checkbox: !!onSale },
    '特價至': { date: saleEndDate ? { start: saleEndDate } : null },
  };
  if (type) props['類型'] = { select: { name: type } };
  if (typeof price === 'number') props['價格'] = { number: price };
  if (avatars.length) {
    props['適用於'] = { multi_select: avatars.map(n => ({ name: n })) };
  }
  if (thumbnail) {
    props['Files & media'] = {
      files: [{ name: 'thumbnail', type: 'external', external: { url: thumbnail } }],
    };
  }
  if (isFullPack) props['Full Set'] = { checkbox: true };

  // 可用於同人製作:
  //   doujin = '允許' | '徵詢' | '禁止' → write
  //   doujin = null + doujinExplicit → explicitly clear (from --doujin clear)
  //   doujin = null + !doujinExplicit → leave untouched (preserve manual edits)
  if (doujin) {
    props['可用於同人製作'] = { select: { name: doujin } };
  } else if (doujinExplicit) {
    props['可用於同人製作'] = { select: null };
  }
  return props;
}

class Notion {
  constructor(token) { this.token = token; }
  async req(p, opts = {}) {
    return fetchJson(`https://api.notion.com/v1${p}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
  }
  findByUrl(url) {
    return this.req(`/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { property: 'URL', url: { equals: url } },
        page_size: 1,
      }),
    }).then(r => r.results?.[0] || null);
  }
  create(properties) {
    return this.req('/pages', {
      method: 'POST',
      body: JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties }),
    });
  }
  update(pageId, properties) {
    return this.req(`/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return; }
  if (!args.url) { usage(); process.exit(1); }
  if (!isBoothUrl(args.url)) die('only booth.pm /items/<id> URLs are supported');

  const jsonUrl = toJsonUrl(args.url);
  const htmlUrl = jsonUrl.replace(/\.json$/, '');
  const [data, html] = await Promise.all([
    fetchJson(jsonUrl),
    fetchText(htmlUrl).catch(e => { console.warn(`[warn] HTML fetch failed: ${e.message}`); return ''; }),
  ]);

  const { price, isFullPack } = pickPrice(data);
  const { onSale, saleEndDate } = parseSaleInfo(data);
  const doujinInfo = parseDoujinInfo(data, html);

  // VN3 auto-extraction kicks in when keyword tier missed but we have license URLs.
  let vn3Auto = null;
  const shouldTryVN3 =
    !args.noVN3Auto &&
    !args.doujinOverride &&
    !doujinInfo.decision &&
    doujinInfo.licenseUrls.length > 0;
  if (shouldTryVN3) {
    vn3Auto = await attemptVN3Auto(doujinInfo.termsText, doujinInfo.licenseUrls);
  }

  // Decide doujin value:
  //   --doujin allow/inquire/prohibit → 允許/徵詢/禁止  (doujinExplicit=true)
  //   --doujin clear                  → null            (doujinExplicit=true → write null to clear)
  //   keyword tier hit                → 允許/徵詢/禁止  (doujinSource='auto-keyword')
  //   VN3 auto succeeded              → 允許/徵詢/禁止  (doujinSource='vn3-auto')
  //   no signal                       → null            (don't touch field)
  let doujin = null, doujinExplicit = false, doujinSource = 'none';
  if (args.doujinOverride === 'clear') {
    doujinExplicit = true;
    doujinSource = 'override:clear';
  } else if (args.doujinOverride) {
    doujin = DOUJIN_OVERRIDE_MAP[args.doujinOverride];
    doujinExplicit = true;
    doujinSource = `override:${args.doujinOverride}`;
  } else if (doujinInfo.decision) {
    doujin = doujinInfo.decision;
    doujinSource = 'auto-keyword';
  } else if (vn3Auto?.ok) {
    doujin = DOUJIN_OVERRIDE_MAP[vn3Auto.decision];
    doujinSource = `vn3-auto:${vn3Auto.decision}`;
  }

  const extracted = {
    name:        data.name,
    type:        pickType(data),
    thumbnail:   pickThumbnail(data),
    url:         data.url || args.url,
    price,
    isFullPack,
    onSale,
    saleEndDate,
    avatars:     matchAvatars(data),
    doujin,
    doujinSource,
  };

  console.log('=== extracted ===');
  console.log(JSON.stringify(extracted, null, 2));

  console.log('\n=== doujin evidence ===');
  console.log(JSON.stringify({
    autoKeywordDecision: doujinInfo.decision,
    keywordHits:         doujinInfo.keywordHits,
    licenseUrls:         doujinInfo.licenseUrls,
    termsExcerpt:        doujinInfo.termsText ? doujinInfo.termsText.slice(0, 600) : null,
    vn3Auto,
  }, null, 2));

  if (
    doujinInfo.licenseUrls.length &&
    !args.doujinOverride &&
    !doujinInfo.decision &&
    !(vn3Auto?.ok)
  ) {
    console.log('\n⚠ VN3 auto-extraction unavailable. Options:');
    console.log('  1. Install pypdf:  pip3 install pypdf  (then re-run)');
    console.log('  2. Read the PDF manually (WebFetch the JP Drive link, find row R) and run:');
    console.log('       --doujin allow|inquire|prohibit');
    if (vn3Auto?.hint) console.log(`  hint: ${vn3Auto.hint}`);
  }

  const properties = buildProperties({ ...extracted, doujinExplicit });

  if (args.dryRun) {
    console.log('\n=== notion payload (dry-run) ===');
    console.log(JSON.stringify(properties, null, 2));
    return;
  }

  const token = readToken();
  if (!token) die('NOTION_API_KEY not set (env or openclaw.json)', 2);
  const notion = new Notion(token);

  const existing = await notion.findByUrl(extracted.url);
  const page = existing
    ? await notion.update(existing.id, properties)
    : await notion.create(properties);

  console.log(`\n✓ ${existing ? 'UPDATED' : 'CREATED'}  ${page.url}`);
}

main().catch(e => { console.error(e?.stack || e); process.exit(1); });
