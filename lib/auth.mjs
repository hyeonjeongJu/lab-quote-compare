import crypto from "crypto";

// 아이디+비번 인증(경량, 회원가입 없음). 비번은 평문 저장 안 함(SHA-256).
// 로그인 성공 시 { id, 만료 }를 HMAC 서명해 HttpOnly 쿠키로. 위조·만료는 서버에서 검증.
const SECRET = process.env.AUTH_SECRET || "";
const DAYS = 90;

function timingEq(a, b) {               // 타이밍 안전 비교
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// 비번 해시: per-user salt + scrypt(memory-hard). 저장 형식 "salt:hash"(둘 다 hex)
export function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const key = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return `${salt}:${key}`;
}
export function verifyPw(pw, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, key] = stored.split(":");
  return timingEq(crypto.scryptSync(String(pw), salt, 32).toString("hex"), key);
}

function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}
export function makeToken(id) {
  const payload = Buffer.from(JSON.stringify({ id, exp: Date.now() + DAYS * 86400000 })).toString("base64url");
  return payload + "." + sign(payload);
}
// 유효하면 로그인 아이디 반환, 아니면 null
export function getAuthUser(req) {
  if (!SECRET) return null;
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)auth=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = decodeURIComponent(m[1]).split(".");
  if (!payload || !sig) return null;
  if (!timingEq(sig, sign(payload))) return null;               // 위조
  let d; try { d = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
  if (!d || !d.id || Number(d.exp) <= Date.now()) return null;  // 만료
  return d.id;
}

const isHttps = req => (req.headers["x-forwarded-proto"] || "http").split(",")[0] === "https";
export function setAuthCookie(res, req, id) {
  const sec = isHttps(req) ? "Secure; " : "";   // 로컬 http에선 Secure 빼서 쿠키 유지
  res.setHeader("Set-Cookie", `auth=${makeToken(id)}; HttpOnly; ${sec}SameSite=Lax; Path=/; Max-Age=${DAYS * 24 * 3600}`);
}
export function clearAuthCookie(res, req) {
  const sec = isHttps(req) ? "Secure; " : "";
  res.setHeader("Set-Cookie", `auth=; HttpOnly; ${sec}SameSite=Lax; Path=/; Max-Age=0`);
}

// 데이터 API 가드 — 미인증이면 401 응답하고 true 반환(핸들러는 즉시 return)
export function blockIfUnauthed(req, res) {
  if (getAuthUser(req)) return false;
  res.status(401).json({ error: "로그인이 필요해요" });
  return true;
}
