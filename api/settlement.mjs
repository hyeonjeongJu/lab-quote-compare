import { createSettlement, getSettlementPurchases } from "../lib/db.mjs";

export const config = { api: { bodyParser: false } };

const readJson = async req => {
  const chunks = []; for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {                    // 정산서 생성 (열린 구매 → 새 정산으로 묶고 리셋)
      const b = await readJson(req);
      if (!b.settledAt) return res.status(422).json({ error: "settledAt 필요" });
      return res.status(200).json(await createSettlement(b.settledAt, b.memo));
    }
    if (req.method === "GET") {                      // 정산 상세(구매 목록) — export용
      const id = new URL(req.url, "http://x").searchParams.get("id");
      if (!id) return res.status(422).json({ error: "id 필요" });
      return res.status(200).json({ rows: await getSettlementPurchases(id) });
    }
    res.status(405).json({ error: "GET/POST only" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
