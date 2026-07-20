import { addPurchase, getPurchases, getPurchasesRange, deletePurchase, vendorExists, updatePurchase } from "../lib/db.mjs";
import { blockIfUnauthed } from "../lib/auth.mjs";

export const config = { api: { bodyParser: false } };

const readJson = async req => {
  const chunks = []; for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

export default async function handler(req, res) {
  try {
    if (blockIfUnauthed(req, res)) return;
    if (req.method === "GET") {
      const url = new URL(req.url, "http://x");
      const from = url.searchParams.get("from"), to = url.searchParams.get("to"), vendor = url.searchParams.get("vendor");
      if (from || to || vendor || url.searchParams.has("limit")) {   // CSV 배치 조회(기간+업체+페이지네이션)
        const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit")) || 1000));
        const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
        const rows = await getPurchasesRange(from || "0001-01-01", to || "9999-12-31", vendor || "", limit, offset);
        return res.status(200).json({ rows });
      }
      return res.status(200).json({ purchases: await getPurchases() });
    }
    if (req.method === "POST") {
      const b = await readJson(req);
      if (!b.code || !b.unitPrice || !b.purchasedAt) return res.status(422).json({ error: "code·unitPrice·purchasedAt 필요" });
      if (!(await vendorExists(b.vendor))) return res.status(422).json({ error: "등록되지 않은 업체예요 (업체 관리에서 확인)" });
      return res.status(200).json(await addPurchase(b));
    }
    if (req.method === "PATCH") {                    // 구매 수정(편집 가능한 값 전체)
      const b = await readJson(req);
      if (!b.id || !b.code || !b.unitPrice || !b.purchasedAt) return res.status(422).json({ error: "id·code·unitPrice·purchasedAt 필요" });
      if (!(await vendorExists(b.vendor))) return res.status(422).json({ error: "등록되지 않은 업체예요 (업체 관리에서 확인)" });
      await updatePurchase(b);
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      await deletePurchase(id);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: "GET/POST/PATCH/DELETE only" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
