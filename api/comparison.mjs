import { getComparison } from "../lib/db.mjs";

export default async function handler(req, res) {
  try {
    res.status(200).json({ rows: await getComparison() });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
