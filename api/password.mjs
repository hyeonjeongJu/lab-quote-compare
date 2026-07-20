import { getAuthUser, hashPw } from "../lib/auth.mjs";
import { setUserPassword } from "../lib/db.mjs";

export const config = { api: { bodyParser: false } };

const readJson = async req => {
  const chunks = []; for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    const id = getAuthUser(req);
    if (!id) return res.status(401).json({ error: "로그인이 필요해요" });
    const b = await readJson(req);
    const pw = String(b.password || ""), confirm = String(b.confirm || "");
    if (!pw || pw.length > 20) return res.status(422).json({ error: "비밀번호는 1~20자예요" });
    if (pw !== confirm) return res.status(422).json({ error: "비밀번호가 일치하지 않아요" });
    await setUserPassword(id, hashPw(pw));
    return res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
