import { getVendors, addVendor, deleteVendor } from "../lib/db.mjs";
import { blockIfUnauthed } from "../lib/auth.mjs";

export const config = { api: { bodyParser: false } };

const readJson = async req => {
  const chunks = []; for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

export default async function handler(req, res) {
  try {
    if (blockIfUnauthed(req, res)) return;
    if (req.method === "GET") return res.status(200).json({ vendors: await getVendors() });
    if (req.method === "POST") {                    // 업체 추가 (수동구매 전용, 비활성)
      const b = await readJson(req);
      if (!b.name?.trim()) return res.status(422).json({ error: "업체명 필요" });
      return res.status(200).json(await addVendor(b.name));
    }
    if (req.method === "DELETE") {                   // 업체 삭제 (기본 등록은 불가)
      const id = new URL(req.url, "http://x").searchParams.get("id");
      if (!id) return res.status(422).json({ error: "id 필요" });
      const r = await deleteVendor(id);
      if (!r.deleted) return res.status(422).json({ error: "기본 등록 업체는 삭제할 수 없어요" });
      return res.status(200).json(r);
    }
    res.status(405).json({ error: "GET/POST/DELETE only" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
