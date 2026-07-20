import { getComparison } from "../lib/db.mjs";
import { blockIfUnauthed } from "../lib/auth.mjs";

export default async function handler(req, res) {
  try {
    if (blockIfUnauthed(req, res)) return;
    res.status(200).json({ rows: await getComparison() });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
