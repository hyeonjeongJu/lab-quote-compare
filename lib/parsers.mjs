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

// ── 에스비(에스비바이오텍): pdf 견적서 파서 — 좌표 기반 컬럼 재구성 ──
// pdf-parse 평면 텍스트는 컬럼이 뭉개져서, pdfjs가 주는 각 글자 x,y로 헤더 컬럼 위치를 잡고 데이터를 버킷팅.
export async function parseEsbi(buffer) {
  const frags = [];
  await pdf(buffer, {
    pagerender: async (pd) => {
      const tc = await pd.getTextContent();
      for (const it of tc.items) if (String(it.str).trim()) frags.push({ x: it.transform[4], y: it.transform[5], w: it.width || 0, s: String(it.str) });
      return "";
    },
  });
  if (!frags.length) return { vendor: "", offerDate: "", expiration: "", offerNo: "", items: [], error: NO_HEADER };

  // y로 행 묶기(근사), 각 행 x 오름차순 → 위에서 아래로
  const byRow = new Map();
  for (const f of frags) { const k = Math.round(f.y / 3); if (!byRow.has(k)) byRow.set(k, []); byRow.get(k).push(f); }
  const rows = [...byRow.keys()].sort((a, b) => b - a).map(k => byRow.get(k).sort((a, b) => a.x - b.x));

  // 행 조각 → 공백 보정 결합(x 간격 크면 공백, 아니면 붙임: pdfjs가 단어 중간을 쪼개므로)
  const join = fs => { let o = ""; for (let i = 0; i < fs.length; i++) { if (i && fs[i].x - (fs[i - 1].x + fs[i - 1].w) > 1.5) o += " "; o += fs[i].s; } return o.replace(/\s+/g, " ").trim(); };

  // 헤더 행 → 컬럼 x중심
  const hi = rows.findIndex(r => r.some(c => /순번/.test(c.s)) && r.some(c => /단가/.test(c.s)));
  if (hi < 0) return { vendor: "에스비바이오텍", offerDate: "", expiration: "", offerNo: "", items: [], error: NO_HEADER };
  const COL = [["no", /순번/], ["code", /품목코드|코드/], ["name", /품목명|품명/], ["spec", /규격/], ["qty", /수량/], ["price", /단가/], ["supply", /공급가/], ["vat", /부가세/], ["due", /납기/]];
  const cols = [];
  for (const c of rows[hi]) { const t = c.s.replace(/\s+/g, ""); const hit = COL.find(([, re]) => re.test(t)); if (hit && !cols.some(x => x.key === hit[0])) cols.push({ key: hit[0], x: c.x }); }
  const cellsOf = r => { const g = {}; for (const c of r) { const k = cols.reduce((b, cc) => Math.abs(c.x - cc.x) < Math.abs(c.x - b.x) ? cc : b).key; (g[k] ??= []).push(c); } const o = {}; for (const k in g) o[k] = join(g[k].sort((a, b) => a.x - b.x)); return o; };

  // 메타
  const rowStr = r => join(r);
  let vendor = "에스비바이오텍";
  const vm = rows.map(rowStr).join(" ").match(/([가-힣A-Za-z]*바이오텍)/); if (vm) vendor = vm[1];
  const dr = rows.find(r => /일자/.test(rowStr(r)) && toDate(rowStr(r)));
  const offerDate = dr ? toDate(rowStr(dr)) : (rows.map(rowStr).map(toDate).find(Boolean) || "");
  const nr = rows.find(r => /견적번호/.test(rowStr(r)));
  const offerNo = nr ? clean((rowStr(nr).split(/견적번호/).pop() || "").replace(/일자.*/, "").trim()) : "";

  // 데이터: 순번+가격 행이 '앵커'(품명 2줄이 앵커 위아래로 갈라지므로 순차 append 불가).
  const rowCells = rows.map(cellsOf);
  const rowY = rows.map(r => (r[0] ? r[0].y : 0));
  const anchors = [];
  for (let i = hi + 1; i < rows.length; i++) { const g = rowCells[i]; if (num(g.no) != null && (num(g.price) != null || g.code)) anchors.push(i); }
  // 품명만 있는 행 → y 기준 가장 가까운 앵커에 배정
  const extra = new Map();
  for (let i = hi + 1; i < rows.length; i++) {
    if (anchors.includes(i) || !rowCells[i].name || /공급가액|합계|소계|부가세|VAT|금액|수량\s*\d/.test(rowCells[i].name)) continue;
    let best = -1, bd = Infinity;
    for (const ai of anchors) { const d = Math.abs(rowY[i] - rowY[ai]); if (d < bd) { bd = d; best = ai; } }
    if (best >= 0) { (extra.get(best) || extra.set(best, []).get(best)).push({ y: rowY[i], name: rowCells[i].name }); }
  }
  const items = anchors.map(ai => {
    const g = rowCells[ai];
    const parts = [{ y: rowY[ai], name: g.name || "" }, ...(extra.get(ai) || [])].sort((a, b) => b.y - a.y);  // 위→아래
    return { code: clean(g.code || ""), name: clean(parts.map(p => p.name).filter(Boolean).join(" ")), spec: clean(g.spec || ""), price: num(g.price) ?? num(g.supply), memo: clean(g.due || "") };
  });

  const out = items.filter(it => (it.name || it.code) && it.price).map(it => {
    const sp = resolveSpec(it.spec, it.code, it.name);
    return { code: it.code, name: it.name, manufacturer: "", spec: it.spec, specAmount: sp.amount, specUnit: sp.unit, price: it.price, memo: it.memo };
  });
  // 품목코드+품목명이 동일한 항목이 여럿이면(예: 3구/2구 멀티탭이 같은 코드 98326) 규격을 코드에 붙여 고유화
  const dup = {};
  for (const it of out) (dup[`${it.code}${it.name}`] ??= []).push(it);
  for (const g of Object.values(dup)) if (g.length > 1) for (const it of g) if (it.spec) it.code = `${it.code}-${it.spec}`;
  const exp = addDays(offerDate, EXPIRE_DAYS);
  if (!out.length) return { vendor, offerDate, expiration: exp, offerNo, items: [], error: NO_HEADER };
  return { vendor, offerDate, expiration: exp, offerNo, items: out };
}

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
