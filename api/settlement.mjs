import { addSettlement, getSettlements, deleteSettlement } from "../lib/db.mjs";

export const config = { api: { bodyParser: false } };

const readJson = async req => {
  const chunks = []; for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return res.status(200).json({ settlements: await getSettlements() });
    if (req.method === "POST") {                    // 정산 추가
      const b = await readJson(req);
      if (!b.vendor || !b.amount || !b.settledAt) return res.status(422).json({ error: "업체·정산금액·정산일 필요" });
      return res.status(200).json(await addSettlement(b));
    }
    if (req.method === "DELETE") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      if (!id) return res.status(422).json({ error: "id 필요" });
      await deleteSettlement(id);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: "GET/POST/DELETE only" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
