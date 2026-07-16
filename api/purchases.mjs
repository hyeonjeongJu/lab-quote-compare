import { addPurchase, getOpenPurchases, deletePurchase, getSettlements, vendorExists } from "../lib/db.mjs";

export const config = { api: { bodyParser: false } };

const readJson = async req => {
  const chunks = []; for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const [open, settlements] = await Promise.all([getOpenPurchases(), getSettlements()]);
      return res.status(200).json({ open, settlements });
    }
    if (req.method === "POST") {
      const b = await readJson(req);
      if (!b.code || !b.unitPrice || !b.purchasedAt) return res.status(422).json({ error: "code·unitPrice·purchasedAt 필요" });
      if (!(await vendorExists(b.vendor))) return res.status(422).json({ error: "등록되지 않은 업체예요 (업체 관리에서 확인)" });
      return res.status(200).json(await addPurchase(b));
    }
    if (req.method === "DELETE") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      await deletePurchase(id);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: "GET/POST/DELETE only" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
