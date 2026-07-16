// 규칙 기반 견적서 파서 (버퍼 입력) — .xls / .pdf → 스키마 정규화
import XLSX from "xlsx";
import pdf from "pdf-parse/lib/pdf-parse.js"; // v1 내부 모듈 직접(index.js 디버그 래퍼가 ESM에서 테스트파일 읽다 크래시하는 것 회피). 구 pdf.js라 canvas/DOMMatrix 불필요

const num = v => { const n = parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10); return isNaN(n) ? null : n; };
const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
const toDate = s => { const m = String(s).match(/(\d{4})[-.\s년]+(\d{1,2})[-.\s월]+(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}` : ""; };

// 규격 문자열 → {amount, unit} (기준단위 g/ml/ea로 정규화). 못 쪼개면 null.
const UNIT = { mg: ["g", 0.001], kg: ["g", 1000], g: ["g", 1], ml: ["ml", 1], ul: ["ml", 0.001], l: ["ml", 1000], ea: ["ea", 1], "개": ["ea", 1], rxns: ["rxn", 1], rxn: ["rxn", 1] };
const mk = (val, u) => { const [base, factor] = UNIT[String(u).toLowerCase()] || []; return base ? { amount: +(parseFloat(val) * factor).toFixed(4), unit: base } : null; };

export function parseSpec(str) {
  const ms = [...String(str ?? "").matchAll(/([\d.]+)\s*(mg|kg|ml|ul|rxns|rxn|l|g|ea|개)\b/gi)];
  if (!ms.length) return { amount: null, unit: null };
  const m = ms[ms.length - 1];              // 규격은 보통 뒤쪽 ("...Extra Pure, 25 g")
  return mk(m[1], m[2]) || { amount: null, unit: null };
}

// 카탈로그 코드 끝 접미사에서 규격 추론: "PHR1423-1G"→1g, "A1234-5MG"→5mg
export function parseSpecFromCode(code) {
  const m = String(code ?? "").match(/-\s*(\d+(?:\.\d+)?)\s*(mg|kg|ml|ul|rxns|rxn|l|g|ea)$/i);
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
  const { text } = await pdf(buffer);
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  let vendor = ""; for (const l of lines) { const m = l.match(/((?:주식회사|㈜|\(주\))\s*[^\t]+)/); if (m) { vendor = clean(m[1].replace(/귀하.*/, "")); break; } }
  let offerDate = ""; for (const l of lines) { const d = toDate(l); if (d) { offerDate = d; break; } }
  const ni = lines.findIndex(l => /number\s*:/i.test(l));      // 견적번호: 같은 줄 값 또는 다음 줄
  const offerNo = ni < 0 ? "" : clean(lines[ni].split(/:/).pop() || lines[ni + 1] || "");

  // v1 텍스트는 한 항목이 여러 줄로 쪼개짐: "{no}.{코드}" / "{품명}" / "{수량}{단가} {금액}{비고?}" / "{비고?}"
  const START = /^(\d+)\.(\S+)$/;                                  // "1.PHR1423-1G"
  const PRICE = /^\d+?([\d,]*,\d{3})\s+[\d,]*,\d{3}(.*)$/;         // 수량+단가 금액 (ponytail: 단가는 천단위 콤마 가정, 콤마 없는 소액 미지원=시약가는 보통 1,000↑)
  const TOTAL = /합계|공급가액|부가세|₩|金|총액/;
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].match(START); if (!s) continue;
    const code = s[2], name = clean(lines[i + 1] || "");
    let pm = null; for (let j = i + 2; j < Math.min(i + 5, lines.length); j++) { pm = lines[j].match(PRICE); if (pm) { i = j; break; } }
    if (!pm) continue;
    let memo = clean(pm[2] || "");
    const nxt = lines[i + 1] || "";
    if (!memo && nxt && !START.test(nxt) && !PRICE.test(nxt) && !TOTAL.test(nxt)) memo = clean(nxt);
    const sp = resolveSpec("", code, name);                       // 코드접미사 → 품명
    items.push({ code, name, manufacturer: "", spec: sp.unit ? `${sp.amount}${sp.unit}` : "", specAmount: sp.amount, specUnit: sp.unit, price: num(pm[1]), memo });
  }
  return { vendor, offerDate, expiration: addDays(offerDate, EXPIRE_DAYS), offerNo, items };
}

export async function parseQuote(filename, buffer) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const q = ext === "pdf" ? await parsePdf(buffer) : parseXls(buffer);
  return { ...q, fileName: filename };
}
