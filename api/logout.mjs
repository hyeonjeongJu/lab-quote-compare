import { clearAuthCookie } from "../lib/auth.mjs";

export default async function handler(req, res) {
  clearAuthCookie(res);
  res.status(200).json({ ok: true });
}
