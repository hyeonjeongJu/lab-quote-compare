// 규칙 기반 견적서 파서 (버퍼 입력) — .xls / .pdf → 스키마 정규화
import XLSX from "xlsx";
import { PDFParse } from "pdf-parse";

const num = v => { const n = parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10); return isNaN(n) ? null : n; };
const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
const toDate = s => { const m = String(s).match(/(\d{4})[-.\s년]+(\d{1,2})[-.\s월]+(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}` : ""; };

// 규격 문자열 → {amount, unit} (기준단위 g/ml/ea로 정규화). 못 쪼개면 null.
const UNIT = { mg: ["g", 0.001], kg: ["g", 1000], g: ["g", 1], ml: ["ml", 1], ul: ["ml", 0.001], l: ["ml", 1000], ea: ["ea", 1], "개": ["ea", 1] };
const mk = (val, u) => { const [base, factor] = UNIT[String(u).toLowerCase()] || []; return base ? { amount: +(parseFloat(val) * factor).toFixed(4), unit: base } : null; };

export function parseSpec(str) {
  const ms = [...String(str ?? "").matchAll(/([\d.]+)\s*(mg|kg|ml|ul|l|g|ea|개)\b/gi)];
  if (!ms.length) return { amount: null, unit: null };
  const m = ms[ms.length - 1];              // 규격은 보통 뒤쪽 ("...Extra Pure, 25 g")
  return mk(m[1], m[2]) || { amount: null, unit: null };
}

// 카탈로그 코드 끝 접미사에서 규격 추론: "PHR1423-1G"→1g, "A1234-5MG"→5mg
export function parseSpecFromCode(code) {
  const m = String(code ?? "").match(/-\s*(\d+(?:\.\d+)?)\s*(mg|kg|ml|ul|l|g|ea)$/i);
  return (m && mk(m[1], m[2])) || { amount: null, unit: null };
}

// 우선순위: 규격 컬럼 → 코드 접미사 → 품명
export function resolveSpec(specRaw, code, name) {
  for (const s of [parseSpec(specRaw), parseSpecFromCode(code), parseSpec(name)]) if (s.amount != null) return s;
  return { amount: null, unit: null };
}

const EXPIRE_DAYS = 7;   // 견적 유효기간 기본값(발행일+7)
const addDays = (iso, d) => { if (!iso) return ""; const dt = new Date(iso + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + d); return dt.toISOString().slice(0, 10); };

// ── .xls ──
export function parseXls(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const flat = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false }).map(r => r.map(clean));
  const cells = flat.flat();

  const vendor = clean(cells.find(c => /(주식회사|㈜|\(주\))/.test(c)) || "");
  let offerDate = ""; for (const c of cells) { const d = toDate(c); if (d) { offerDate = d; break; } }

  const hi = flat.findIndex(r => r.some(c => /cat\.?\s*no|제품번호|품번/i.test(c)));
  if (hi < 0) return { vendor, offerDate, expiration: addDays(offerDate, EXPIRE_DAYS), offerNo: "", items: [] };
  const H = flat[hi], col = re => H.findIndex(c => re.test(c));
  const ci = { mfr: col(/제조회사|제조사|maker|brand/i), code: col(/cat\.?\s*no|제품번호|품번/i), name: col(/품\s*명|품\s*목|제품명/), spec: col(/규\s*격|size|unit/i), price: col(/단\s*가|unit\s*price/i), amount: col(/금\s*액|amount/i), memo: col(/비\s*고|소요|기간|remark/i) };

  const items = [];
  for (let i = hi + 1; i < flat.length; i++) {
    const r = flat[i], code = clean(r[ci.code]), name = clean(r[ci.name]);
    if (!code && !name) continue;
    const price = num(r[ci.price]) ?? num(r[ci.amount]);
    if (!price) continue;
    const specRaw = ci.spec >= 0 ? clean(r[ci.spec]) : "";
    const sp = resolveSpec(specRaw, code, name);      // 규격컬럼 → 코드접미사 → 품명
    items.push({ code, name, manufacturer: ci.mfr >= 0 ? clean(r[ci.mfr]) : "", spec: specRaw, specAmount: sp.amount, specUnit: sp.unit, price, memo: ci.memo >= 0 ? clean(r[ci.memo]) : "" });
  }
  return { vendor, offerDate, expiration: addDays(offerDate, EXPIRE_DAYS), offerNo: "", items };
}

// ── .pdf ──
export async function parsePdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();
  await parser.destroy();
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  let vendor = ""; for (const l of lines) { const m = l.match(/((?:주식회사|㈜|\(주\))\s*[^\t]+)/); if (m) { vendor = clean(m[1].replace(/귀하.*/, "")); break; } }
  const offerNo = clean((lines.find(l => /number\s*:/i.test(l)) || "").split(/:/).pop() || "");
  let offerDate = ""; for (const l of lines) { const d = toDate(l); if (d) { offerDate = d; break; } }

  const re = /^(\d+)\.?\s+(\S+)\s+(.+?)\s+(\d+)\s+([\d,]+)\s+([\d,]+)(?:\s+(.*))?$/;
  const items = [];
  for (const l of lines) {
    const m = l.match(re); if (!m) continue;
    const name = clean(m[3]), sp = resolveSpec("", m[2], name);   // 코드접미사 → 품명
    items.push({ code: m[2], name, manufacturer: "", spec: sp.unit ? `${sp.amount}${sp.unit}` : "", specAmount: sp.amount, specUnit: sp.unit, price: num(m[5]), memo: clean(m[7] || "") });
  }
  return { vendor, offerDate, expiration: addDays(offerDate, EXPIRE_DAYS), offerNo, items };
}

export async function parseQuote(filename, buffer) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const q = ext === "pdf" ? await parsePdf(buffer) : parseXls(buffer);
  return { ...q, fileName: filename };
}
