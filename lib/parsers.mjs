// 규칙 기반 견적서 파서 (버퍼 입력) — .xls / .pdf → 스키마 정규화
import XLSX from "xlsx";
import pdf from "pdf-parse/lib/pdf-parse.js"; // v1 내부 모듈 직접(index.js 디버그 래퍼가 ESM에서 테스트파일 읽다 크래시하는 것 회피). 구 pdf.js라 canvas/DOMMatrix 불필요

const num = v => { const n = parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10); return isNaN(n) ? null : n; };
const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = n => String(n).padStart(2, "0");
const toDate = s => {
  s = String(s ?? "");
  const m = s.match(/(\d{4})[-.\s/년]+(\d{1,2})[-.\s/월]+(\d{1,2})/);         // 2026-07-24 / 2026.07.24 / 2026/07/24 / 2026년 7월 24일
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

// ── 컬럼 동의어 (헤더 문구 변형 흡수: 제품번호↔품목코드, 품목명↔품목 등). 순서 중요(코드가 품명보다 먼저) ──
const COLSYN = [
  ["no",     /순번|순서|일련|^no\.?$/i],
  ["code",   /품목코드|제품번호|제품코드|물품코드|품번|cat\.?no|catalog|코드/i],
  ["name",   /품목명|제품명|물품명|품명|품목|item|name/i],
  ["spec",   /규격|용량|포장|size|unit(?!price)/i],
  ["qty",    /수량|qty|quantity/i],
  ["price",  /단가|unitprice/i],
  ["supply", /공급가|공급가액|금액|amount/i],
  ["vat",    /부가세|세액|vat/i],
  ["due",    /예상납기|납기|납품|delivery|leadtime/i],
  ["note",   /적요|비고|remark|memo/i],
];

// ── PDF 견적서 공용 파서 — pdfjs 좌표로 컬럼 재구성 (팜텍·에스비 등 표형 PDF) ──
// 평면 텍스트론 컬럼이 뭉개지므로, 각 글자 x,y로 헤더 컬럼 위치를 잡고 데이터를 버킷팅.
// 품목코드+품목명은 헤더 정렬이 어긋나기 쉬워 한 구간으로 묶고 '첫 토큰=코드, 나머지=품명'으로 분리.
async function parsePdfTable(buffer, cfg) {
  const frags = [];
  await pdf(buffer, { pagerender: async (pd) => { const tc = await pd.getTextContent(); for (const it of tc.items) if (String(it.str).trim()) frags.push({ x: it.transform[4], y: it.transform[5], w: it.width || 0, s: String(it.str) }); return ""; } });
  const fail = err => ({ vendor: cfg.fallback, offerDate: "", expiration: "", offerNo: "", items: [], error: err });
  if (!frags.length) return fail(NO_HEADER);

  const byRow = new Map();
  for (const f of frags) { const k = Math.round(f.y / 3); if (!byRow.has(k)) byRow.set(k, []); byRow.get(k).push(f); }
  const rows = [...byRow.keys()].sort((a, b) => b - a).map(k => byRow.get(k).sort((a, b) => a.x - b.x));
  const join = fs => { let o = ""; for (let i = 0; i < fs.length; i++) { if (i && fs[i].x - (fs[i - 1].x + fs[i - 1].w) > 1.5) o += " "; o += fs[i].s; } return o.replace(/\s+/g, " ").trim(); };
  const rowStr = r => join(r);

  const hi = rows.findIndex(r => r.some(c => /순번/.test(c.s)) && r.some(c => /단가/.test(c.s.replace(/\s/g, ""))));
  if (hi < 0) return fail(NO_HEADER);
  const colX = {};
  for (const c of rows[hi]) { const t = c.s.replace(/\s+/g, ""); const hit = COLSYN.find(([, re]) => re.test(t)); if (hit && colX[hit[0]] == null) colX[hit[0]] = c.x; }
  if (colX.no == null || colX.code == null || colX.price == null)
    return fail(`견적서 양식이 바뀐 것 같아요 — 필수 컬럼(순번/품목코드/단가)을 못 찾았어요. 헤더를 확인하고, 업체 양식이 변경된 거면 개발자에게 수정 요청해주세요. (읽은 헤더: ${rowStr(rows[hi])})`);

  const afterName = [colX.spec, colX.qty, colX.price].filter(v => v != null).sort((a, b) => a - b)[0];
  const nameLeft = (colX.no + colX.code) / 2;
  const codenameEnd = ((colX.name ?? colX.code) + afterName) / 2;
  const NUM = ["spec", "qty", "price", "supply", "vat", "due", "note"].filter(k => colX[k] != null).map(k => [k, colX[k]]);
  const nearest = x => NUM.reduce((b, c) => Math.abs(x - c[1]) < Math.abs(x - b[1]) ? c : b)[0];
  const cellsOf = r => {
    const cn = [], acc = {};
    for (const c of r) { if (c.x < nameLeft) (acc.no ??= []).push(c); else if (c.x < codenameEnd) cn.push(c); else { const k = nearest(c.x); (acc[k] ??= []).push(c); } }
    const o = { no: acc.no ? join(acc.no) : "", codename: join(cn) };
    for (const [k, v] of Object.entries(acc)) if (k !== "no") o[k] = join(v.sort((a, b) => a.x - b.x));
    return o;
  };

  const rowCells = rows.map(cellsOf);
  const rowY = rows.map(r => (r[0] ? r[0].y : 0));
  const anchors = [];
  for (let i = hi + 1; i < rows.length; i++) { const g = rowCells[i]; if (num(g.no) != null && (num(g.price) != null || g.codename)) anchors.push(i); }
  const extra = new Map();
  for (let i = hi + 1; i < rows.length; i++) {
    if (anchors.includes(i)) continue;
    const nm = rowCells[i].codename;
    if (!nm || /공급가|합계|소계|부가세|vat|금액|수량\s*\d|₩/i.test(nm)) continue;
    let best = -1, bd = Infinity; for (const ai of anchors) { const d = Math.abs(rowY[i] - rowY[ai]); if (d < bd) { bd = d; best = ai; } }
    if (best >= 0) (extra.get(best) || extra.set(best, []).get(best)).push({ y: rowY[i], t: nm });
  }
  const items = anchors.map(ai => {
    const g = rowCells[ai];
    const parts = g.codename.split(/\s+/);
    const code = parts.shift() || "";
    const nameRows = [{ y: rowY[ai], t: parts.join(" ") }, ...(extra.get(ai) || [])].sort((a, b) => b.y - a.y);
    return { code: clean(code), name: clean(nameRows.map(n => n.t).filter(Boolean).join(" ")), spec: clean(g.spec || ""), price: num(g.price) ?? num(g.supply), memo: clean(g.due || g.note || "") };
  });

  let vendor = cfg.fallback;
  const vm = rows.map(rowStr).join(" ").match(cfg.vendorRe); if (vm) vendor = clean(vm[1] || vm[0]);
  const dr = rows.find(r => /일자/.test(rowStr(r)) && toDate(rowStr(r)));
  const offerDate = dr ? toDate(rowStr(dr)) : (rows.map(rowStr).map(toDate).find(Boolean) || "");
  const nr = rows.find(r => /견적\s*(?:no|번호)/i.test(rowStr(r)));
  const offerNo = nr ? clean((rowStr(nr).split(/견적\s*(?:no\.?|번호)/i).pop() || "").replace(/^[:\s]*/, "").replace(/\s*일자.*/, "").trim()) : "";

  const out = items.filter(it => (it.name || it.code) && it.price).map(it => {
    const sp = resolveSpec(it.spec, it.code, it.name);
    return { code: it.code, name: it.name, manufacturer: "", spec: it.spec, specAmount: sp.amount, specUnit: sp.unit, price: it.price, memo: it.memo };
  });
  const dup = {}; for (const it of out) (dup[`${it.code}${it.name}`] ??= []).push(it);
  for (const g of Object.values(dup)) if (g.length > 1) for (const it of g) if (it.spec) it.code = `${it.code}-${it.spec}`;

  const exp = addDays(offerDate, EXPIRE_DAYS);
  return out.length ? { vendor, offerDate, expiration: exp, offerNo, items: out } : fail(NO_HEADER);
}

export const parsePamtek = buffer => parsePdfTable(buffer, { fallback: "(주)팜텍", vendorRe: /(\(주\)\s*팜텍|㈜\s*팜텍|주식회사\s*팜텍|팜텍)/ });

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


export const parseEsbi = buffer => parsePdfTable(buffer, { fallback: "에스비바이오텍", vendorRe: /([가-힣]*바이오텍)/ });

// 업체별 파서 라우팅 — 선택 업체 우선, 없으면 확장자 폴백. 새 업체는 여기에 파서 등록
const VENDOR_PARSER = {
  "비티비(동인)": parseBitibi,
  "팜텍": parsePamtek,
  "삼보": parseSambo,
  "에스비": parseEsbi,
};
export async function parseQuote(filename, buffer, vendor) {
  const byVendor = VENDOR_PARSER[vendor];
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const parse = byVendor || (ext === "pdf" ? parsePamtek : parseBitibi);
  const q = await parse(buffer);        // 동기 파서도 await로 통일
  return { ...q, fileName: filename };
}
