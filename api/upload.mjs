import { parseQuote } from "../lib/parsers.mjs";
import { saveQuote } from "../lib/db.mjs";

// 프론트가 파일 원본을 raw body로 POST, 파일명은 ?name= 쿼리로 전달 (multipart 파싱 회피)
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buffer = Buffer.concat(chunks);
    const name = decodeURIComponent(new URL(req.url, "http://x").searchParams.get("name") || "upload");

    const parsed = await parseQuote(name, buffer);
    if (!parsed.items.length) return res.status(422).json({ error: "견적 품목을 못 찾음 (형식 확인)", parsed });
    const saved = await saveQuote(parsed);
    res.status(200).json({ ok: true, vendor: parsed.vendor, items: parsed.items.length, ...saved });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
