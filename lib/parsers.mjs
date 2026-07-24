// 규칙 기반 견적서 파서 (버퍼 입력) — .xls / .pdf → 스키마 정규화
import XLSX from "xlsx";
import pdf from "pdf-parse/lib/pdf-parse.js"; // v1 내부 모듈 직접(index.js 디버그 래퍼가 ESM에서 테스트파일 읽다 크래시하는 것 회피). 구 pdf.js라 canvas/DOMMatrix 불필요

const num = v => { const n = parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10); return isNaN(n) ? null : n; };
const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = n => String(n).padStart(2, "0");
const toDate = s => {
  s = String(s ?? "");
  const m = s.match(/(\d{4})[-.\s년]+(\d{1,2})[-.\s월]+(\d{1,2})/);           // 2026-07-24 / 2026.07.24 / 2026년 7월 24일
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  const em = s.match(/([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})/);       // "July 24, 2026" (엑셀 영문 날짜서식)
  if (em && MONTHS[em[1].toLowerCase()]) return `${em[3]}-${pad2(MONTHS[em[1].toLowerCase()])}-${pad2(em[2])}`;
  return "";
};

// 규격 문자열 → {amount, unit} (기준단위 g/ml/ea/m로 정규화). 못 쪼개면 null.
const UNIT = { mg: ["g", 0.001], kg: ["g", 1000], g: ["g", 1], ml: ["ml", 1], ul: ["ml", 0.001], l: ["ml", 1000], m: ["m", 1], cm: ["m", 0.01], mm: ["m", 0.001], ea: ["ea", 1], "개": ["ea", 1], rxns: ["rxn", 1], rxn: ["rxn", 1] };
const mk = (val, u) => { const [base, factor] = UNIT[String(u).toLowerCase()] || []; return base ? { amount: +(parseFloat(val) * factor).toFixed(4), unit: base } : null; };

export function parseSpec(str) {
  const ms = [...String(str ?? "").matchAll(/([\d.]+)\s*(mg|kg|mm|cm|ml|ul|rxns|rxn|l|g|m|ea|개)\b/gi)];
  if (!ms.length) return { amount: null, unit: null };
  const m = ms[ms.length - 1];              // 규격은 보통 뒤쪽 ("...Extra Pure, 25 g")
  return mk(m[1], m[2]) || { amount: null, unit: null };
}

// 카탈로그 코드 끝 접미사에서 규격 추론: "PHR1423-1G"→1g, "A1234-5MG"→5mg
export function parseSpecFromCode(code) {
  const m = String(code ?? "").match(/-\s*(\d+(?:\.\d+)?)\s*(mg|kg|mm|cm|ml|ul|rxns|rxn|l|g|m|ea)$/i);
  return (m && mk(m[1], m[2])) || { amount: null, unit: null };
}

// 우선순위: 규격 컬럼 → 코드 접미사 → 품명
export function resolveSpec(specRaw, code, name) {
  for (const s of [parseSpec(specRaw), parseSpecFromCode(code), parseSpec(name)]) if (s.amount != null) return s;
  return { amount: null, unit: null };
}

const EXPIRE_DAYS = 7;   // 견적 유효기간 기본값(발행일+7)
const addDays = (iso, d) => { if (!iso) return ""; const dt = new Date(iso + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + d); return dt.toISOString().slice(0, 10); };

// 필수 컬럼(품번·품명·단가)이 헤더에 잡혔는지 검증. 없으면 사용자용 안내 문구, 있으면 null.
// 파일에서 읽은 실제 헤더를 같이 넣어줘서(개발자가 뭐가 바뀐지 즉시 파악) 수정 반영이 빠름.
function headerError(H, ci) {
  const missing = [];
  if (ci.code < 0) missing.push("품번");
  if (ci.name < 0) missing.push("품명");
  if (ci.price < 0 && ci.amount < 0) missing.push("단가(또는 공급가/금액)");
  if (!missing.length) return null;
  const seen = H.filter(Boolean).join(" · ") || "(빈 헤더)";
  return `견적서 양식이 바뀐 것 같아요 — 기존 컬럼명 [${missing.join(", ")}]을(를) 못 찾았어요. 헤더를 확인하고, 업체 양식이 변경된 거면 개발자에게 수정 요청해주세요. (파일에서 읽은 헤더: ${seen})`;
}
const NO_HEADER = "견적서 헤더(품번 컬럼이 있는 행)를 못 찾았어요. 헤더를 확인하고, 업체 양식이 변경된 거면 개발자에게 수정 요청해주세요.";

// ── 비티비(동인): xls 견적서 파서 ──
export function parseBitibi(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const flat = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false }).map(r => r.map(clean));
  const cells = flat.flat();

  const vendor = clean(cells.find(c => /(주식회사|㈜|\(주\))/.test(c)) || "");
  let offerDate = ""; for (const c of cells) { const d = toDate(c); if (d) { offerDate = d; break; } }

  const exp = addDays(offerDate, EXPIRE_DAYS);
  const hi = flat.findIndex(r => r.some(c => /cat\.?\s*no|제품번호|품번/i.test(c)));
  if (hi < 0) return { vendor, offerDate, expiration: exp, offerNo: "", items: [], error: NO_HEADER };
  const H = flat[hi], col = re => H.findIndex(c => re.test(c));
  const ci = { mfr: col(/제조회사|제조사|maker|brand/i), code: col(/cat\.?\s*no|제품번호|품번/i), name: col(/품\s*명|품\s*목|제품명/), spec: col(/규\s*격|size|unit/i), price: col(/단\s*가|unit\s*price/i), amount: col(/금\s*액|amount/i), memo: col(/비\s*고|소요|기간|remark/i) };
  const err = headerError(H, ci);
  if (err) return { vendor, offerDate, expiration: exp, offerNo: "", items: [], error: err };

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

// ── 팜텍: pdf 견적서 파서 ──
export async function parsePamtek(buffer) {
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

// ── 삼보(㈜삼보과학): xlsx 견적서 파서 ──
// 레이아웃: 회사명 G3(㈜삼보과학), 발행일 B4, 헤더행(NO·제조사·품번·품명·규격·수량·단가·공급가·부가세·재고)
// 헤더 한글에 내부 공백이 있어("품   번") 공백 허용 정규식 사용. 재고 컬럼(납기)→memo.
export function parseSambo(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const flat = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false }).map(r => r.map(clean));
  const cells = flat.flat();

  const vendor = clean(cells.find(c => /삼보|주식회사|㈜|\(주\)/.test(c)) || "");
  let offerDate = ""; for (const c of cells) { const d = toDate(c); if (d) { offerDate = d; break; } }

  const exp = addDays(offerDate, EXPIRE_DAYS);
  const hi = flat.findIndex(r => r.some(c => /품\s*번|cat\.?\s*no|제품번호/i.test(c)));
  if (hi < 0) return { vendor, offerDate, expiration: exp, offerNo: "", items: [], error: NO_HEADER };
  const H = flat[hi], col = re => H.findIndex(c => re.test(c));
  const ci = {
    mfr: col(/제조\s*사|제조\s*회사|maker|brand/i),
    code: col(/품\s*번|cat\.?\s*no|제품번호/i),
    name: col(/품\s*명|제품명/),
    spec: col(/규\s*격|size|unit/i),
    price: col(/단\s*가|unit\s*price/i),
    amount: col(/공\s*급\s*가|금\s*액|amount/i),
    memo: col(/재\s*고|비\s*고|납\s*기|기간|remark/i),
  };
  const err = headerError(H, ci);
  if (err) return { vendor, offerDate, expiration: exp, offerNo: "", items: [], error: err };

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

// 업체별 파서 라우팅 — 선택 업체 우선, 없으면 확장자 폴백. 새 업체는 여기에 파서 등록
const VENDOR_PARSER = {
  "비티비(동인)": parseBitibi,
  "팜텍": parsePamtek,
  "삼보": parseSambo,
};
export async function parseQuote(filename, buffer, vendor) {
  const byVendor = VENDOR_PARSER[vendor];
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const parse = byVendor || (ext === "pdf" ? parsePamtek : parseBitibi);
  const q = await parse(buffer);        // 동기 파서도 await로 통일
  return { ...q, fileName: filename };
}
