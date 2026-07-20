import { verifyPw, setAuthCookie, getAuthUser } from "../lib/auth.mjs";
import { getUser } from "../lib/db.mjs";

export const config = { api: { bodyParser: false } };

const readJson = async req => {
  const chunks = []; for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {              // 현재 로그인 상태(누구인지)
      const id = getAuthUser(req);
      if (!id) return res.status(401).json({ error: "로그인이 필요해요" });
      return res.status(200).json({ id });
    }
    if (req.method === "POST") {             // 로그인
      const b = await readJson(req);
      const id = String(b.id || "").trim();
      if (!id || !b.password) return res.status(422).json({ error: "아이디·비밀번호를 입력하세요" });
      const u = await getUser(id);
      if (!u || !verifyPw(b.password, u.pw_hash))             // 어느 쪽이 틀렸는지 노출 안 함
        return res.status(401).json({ error: "아이디 또는 비밀번호가 틀려요" });
      setAuthCookie(res, req, u.id);
      return res.status(200).json({ ok: true, id: u.id });
    }
    res.status(405).json({ error: "GET/POST only" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
