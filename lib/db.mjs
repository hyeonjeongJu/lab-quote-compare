import pg from "pg";

pg.types.setTypeParser(1082, v => v); // DATE(1082)를 문자열 그대로 → 타임존 하루 밀림 방지

// 서버리스 환경에서 모듈 스코프로 풀 재사용 (Neon 풀드 연결)
const url = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const pool = new pg.Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, // 로컬은 SSL off, Neon은 on
  max: 3,
});

// 견적서 저장 — 같은 파일명이면 교체(dedup), 상품은 upsert(빈 값만 채움), offer 삽입
export async function saveQuote(q) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM quote WHERE file_name = $1", [q.fileName]); // 재업로드 교체
    const { rows: [quote] } = await client.query(
      `INSERT INTO quote (vendor, offer_date, expiration_date, offer_no, file_name)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [q.vendor || null, q.offerDate || null, q.expiration || null, q.offerNo || null, q.fileName]
    );
    for (const it of q.items) {
      const { rows: [prod] } = await client.query(
        `INSERT INTO product (code, name, manufacturer, spec, spec_amount, spec_unit)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET
           name         = COALESCE(NULLIF(EXCLUDED.name,''), product.name),
           manufacturer = COALESCE(NULLIF(EXCLUDED.manufacturer,''), product.manufacturer),
           spec         = COALESCE(NULLIF(EXCLUDED.spec,''), product.spec),
           spec_amount  = COALESCE(EXCLUDED.spec_amount, product.spec_amount),
           spec_unit    = COALESCE(EXCLUDED.spec_unit, product.spec_unit)
         RETURNING id`,
        [it.code, it.name || "", it.manufacturer || "", it.spec || "", it.specAmount, it.specUnit]
      );
      await client.query(
        "INSERT INTO offer (quote_id, product_id, price, memo) VALUES ($1,$2,$3,$4)",
        [quote.id, prod.id, it.price, it.memo || null]
      );
    }
    await client.query("COMMIT");
    return { quoteId: quote.id, items: q.items.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// 코드별 최저가 비교: (상품,업체)별 최신 견적의 가격만 → 단위당가격 계산해서 반환
export async function getComparison() {
  const { rows } = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (o.product_id, q.vendor)
        o.product_id, q.vendor, o.price, o.memo,
        q.offer_date, q.expiration_date
      FROM offer o JOIN quote q ON q.id = o.quote_id
      ORDER BY o.product_id, q.vendor, q.offer_date DESC NULLS LAST, q.id DESC
    )
    SELECT p.code, p.name, p.manufacturer, p.spec, p.spec_amount, p.spec_unit,
           l.vendor, l.price, l.memo, l.offer_date, l.expiration_date,
           CASE WHEN p.spec_amount > 0 THEN round(l.price * 1.1 / p.spec_amount) END AS unit_price   -- 구매가(부가세 포함) 기준 단위당
    FROM product p JOIN latest l ON l.product_id = p.id
    ORDER BY p.code, unit_price NULLS LAST, l.price
  `);
  return rows;
}

// ── 구매/정산 ──

// 구매 추가 — 그 시점 값 freeze(스냅샷). product_id는 code로 조회해 연결(없어도 기록은 남김)
export async function addPurchase(p) {
  const { rows } = await pool.query(
    `INSERT INTO purchase (product_id, code, name, vendor, unit_price, qty, purchased_at, manual)
     VALUES ((SELECT id FROM product WHERE code = $1), $1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [p.code, p.name || "", p.vendor || "", p.unitPrice, p.qty || 1, p.purchasedAt, p.manual !== false]
  );
  return { id: rows[0].id };
}

// 구매 목록 + 누적 총액
export async function getPurchases() {
  const { rows } = await pool.query(`
    SELECT id, code, name, vendor, unit_price, qty,
           unit_price * qty AS amount, purchased_at, delivered_at, manual
    FROM purchase
    ORDER BY purchased_at DESC NULLS LAST, id DESC
  `);
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  return { rows, total };
}

// CSV용 기간+업체 조회(페이지네이션) — 대량 export를 1000건씩 배치로 받기 위함. vendor=''이면 전체
export async function getPurchasesRange(from, to, vendor, limit, offset) {
  const { rows } = await pool.query(`
    SELECT id, code, name, vendor, unit_price, qty,
           unit_price * qty AS amount, purchased_at, delivered_at, manual
    FROM purchase
    WHERE purchased_at >= $1 AND purchased_at <= $2 AND ($3 = '' OR vendor = $3)
    ORDER BY purchased_at DESC NULLS LAST, id DESC
    LIMIT $4 OFFSET $5
  `, [from, to, vendor || "", limit, offset]);
  return rows;
}

// 구매 삭제
export async function deletePurchase(id) {
  await pool.query("DELETE FROM purchase WHERE id = $1", [id]);
}

// 구매 수정 — 편집 가능한 값 전체 갱신. product_id는 code로 재링크(없어도 기록 유지)
export async function updatePurchase(p) {
  await pool.query(
    `UPDATE purchase SET
       product_id   = (SELECT id FROM product WHERE code = $2),
       code         = $2, name = $3, vendor = $4,
       unit_price   = $5, qty = $6, purchased_at = $7, delivered_at = $8
     WHERE id = $1`,
    [p.id, p.code, p.name || "", p.vendor || "", p.unitPrice, p.qty || 1, p.purchasedAt, p.deliveredAt || null]
  );
}

// ── 정산(외상장부 credit) ──
// ponytail: 미정산 = 업체별 전체 구매합 − 전체 정산합(매번 재계산). 1인 실험실 규모(연 수십~수백 건)라
//   스캔 비용 무시 가능하고 편집도 항상 자동 반영. 옛 기록을 지우고 싶어지면(누적 부담) →
//   업체별 이월잔액 테이블 vendor_opening(vendor,amount) 추가해 [정리] 시점 미정산을 숫자로 굳히고
//   그 이전 row 삭제 → 미정산 = 이월잔액 + 이후 구매·정산. 날짜/기간 개념 없이 업체별 리베이스.

// 정산 추가 — 업체에 갚은 금액 1건
export async function addSettlement(s) {
  const { rows } = await pool.query(
    "INSERT INTO settlement (vendor, amount, settled_at, memo) VALUES ($1,$2,$3,$4) RETURNING id",
    [s.vendor, s.amount, s.settledAt, s.memo || null]
  );
  return { id: rows[0].id };
}

// 정산 목록 (최신순)
export async function getSettlements() {
  const { rows } = await pool.query(
    "SELECT id, vendor, amount, settled_at, memo FROM settlement ORDER BY settled_at DESC, id DESC"
  );
  return rows;
}

// 정산 삭제
export async function deleteSettlement(id) {
  await pool.query("DELETE FROM settlement WHERE id = $1", [id]);
}

// ── 업체 마스터 ──

// 업체 목록 (기본 등록 먼저, 이름순)
export async function getVendors() {
  const { rows } = await pool.query("SELECT id, name, active, builtin FROM vendor ORDER BY builtin DESC, name");
  return rows;
}

// 업체 추가 — 사용자 추가분은 수동 구매 전용(active=false, builtin=false)
export async function addVendor(name) {
  const { rows } = await pool.query(
    `INSERT INTO vendor (name, active, builtin) VALUES ($1, false, false)
     ON CONFLICT (name) DO NOTHING RETURNING id`,
    [String(name).trim()]
  );
  return { id: rows[0]?.id ?? null };
}

// 업체 삭제 — 기본 등록(builtin) 업체는 불가. 삭제해도 purchase/quote의 업체명(TEXT 스냅샷)은 보존
export async function deleteVendor(id) {
  const { rowCount } = await pool.query("DELETE FROM vendor WHERE id = $1 AND builtin = false", [id]);
  return { deleted: rowCount > 0 };
}

// 견적 업로드 허용 업체인지(활성) — 업로드 서버 가드용
export async function isVendorActive(name) {
  const { rows } = await pool.query("SELECT active FROM vendor WHERE name = $1", [name]);
  return rows[0]?.active === true;
}

// 등록된 업체인지 — 구매 추가 서버 가드용(활성 무관)
export async function vendorExists(name) {
  const { rows } = await pool.query("SELECT 1 FROM vendor WHERE name = $1", [name]);
  return rows.length > 0;
}
