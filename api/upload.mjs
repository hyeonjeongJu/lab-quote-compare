import { parseQuote } from "../lib/parsers.mjs";
import { saveQuote, isVendorActive } from "../lib/db.mjs";
import { blockIfUnauthed } from "../lib/auth.mjs";

// 프론트가 파일 원본을 raw body로 POST, 파일명은 ?name= 쿼리로 전달 (multipart 파싱 회피)
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    if (blockIfUnauthed(req, res)) return;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buffer = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const name = decodeURIComponent(url.searchParams.get("name") || "upload");
    const vendor = decodeURIComponent(url.searchParams.get("vendor") || "");   // 라디오로 고른 업체(통제 목록)

    if (!vendor) return res.status(422).json({ error: "업체를 선택하세요" });
    if (!(await isVendorActive(vendor)))                                       // 개발자가 활성한 업체만 업로드 허용
      return res.status(422).json({ error: `'${vendor}'는 견적 업로드 지원 업체가 아니에요 (파서 미검증)` });

    const parsed = await parseQuote(name, buffer, vendor);
    if (!parsed.items.length) return res.status(422).json({ error: `견적 품목을 못 찾았어요. '${vendor}' 견적서 형식이 맞는지(업체 선택·파일) 확인하세요.`, parsed });

    // 선택 업체 ↔ 파일 속 업체명 일치 검증 (공백·법인격 무시, 파일에서 업체명 못 읽으면 통과)
    const norm = s => String(s || "").replace(/\s+/g, "").replace(/주식회사|㈜|\(주\)/g, "");
    const kw = norm(vendor.replace(/\(.*?\)/g, ""));   // "비티비(동인)"→"비티비"
    const pv = norm(parsed.vendor);
    if (pv && kw && !pv.includes(kw))
      return res.status(422).json({ error: `선택한 업체 '${vendor}'와 파일 속 업체명('${parsed.vendor}')이 안 맞아요. 업체를 다시 확인하세요.` });

    parsed.vendor = vendor;                                                    // 파싱값 대신 선택값으로 확정(드리프트 차단)
    const saved = await saveQuote(parsed);
    res.status(200).json({ ok: true, vendor: parsed.vendor, items: parsed.items.length, ...saved });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
