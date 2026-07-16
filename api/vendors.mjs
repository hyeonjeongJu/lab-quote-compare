import { getVendors, addVendor, setVendorActive } from "../lib/db.mjs";

export const config = { api: { bodyParser: false } };

const readJson = async req => {
  const chunks = []; for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return res.status(200).json({ vendors: await getVendors() });
    if (req.method === "POST") {                    // 업체 추가
      const b = await readJson(req);
      if (!b.name?.trim()) return res.status(422).json({ error: "업체명 필요" });
      return res.status(200).json(await addVendor(b.name, b.active !== false));
    }
    if (req.method === "PATCH") {                    // 활성 토글
      const b = await readJson(req);
      if (!b.id) return res.status(422).json({ error: "id 필요" });
      await setVendorActive(b.id, !!b.active);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: "GET/POST/PATCH only" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
