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
           CASE WHEN p.spec_amount > 0 THEN round(l.price / p.spec_amount) END AS unit_price
    FROM product p JOIN latest l ON l.product_id = p.id
    ORDER BY p.code, unit_price NULLS LAST, l.price
  `);
  return rows;
}

// ── 구매/정산 ──

// 구매 추가 — 그 시점 값 freeze(스냅샷). product_id는 code로 조회해 연결(없어도 기록은 남김)
export async function addPurchase(p) {
  const { rows } = await pool.query(
    `INSERT INTO purchase (product_id, code, name, vendor, unit_price, qty, purchased_at)
     VALUES ((SELECT id FROM product WHERE code = $1), $1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [p.code, p.name || "", p.vendor || "", p.unitPrice, p.qty || 1, p.purchasedAt]
  );
  return { id: rows[0].id };
}

// 열린 사이클(아직 정산 안 된) 구매 목록 + 누적 총액
export async function getOpenPurchases() {
  const { rows } = await pool.query(`
    SELECT id, code, name, vendor, unit_price, qty,
           unit_price * qty AS amount, purchased_at
    FROM purchase WHERE settlement_id IS NULL
    ORDER BY purchased_at DESC NULLS LAST, id DESC
  `);
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  return { rows, total };
}

// 구매 삭제(열린 것만; 실수 정정용)
export async function deletePurchase(id) {
  await pool.query("DELETE FROM purchase WHERE id = $1 AND settlement_id IS NULL", [id]);
}

// 정산서 생성 — 현 시점 열린 구매들을 새 settlement로 묶고 사이클 리셋
export async function createSettlement(settledAt, memo) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [tot] } = await client.query(
      "SELECT COALESCE(SUM(unit_price * qty),0) AS total, COUNT(*) AS n FROM purchase WHERE settlement_id IS NULL"
    );
    if (Number(tot.n) === 0) throw new Error("정산할 구매내역이 없어요");
    const { rows: [s] } = await client.query(
      "INSERT INTO settlement (settled_at, total_amount, memo) VALUES ($1,$2,$3) RETURNING id",
      [settledAt, Number(tot.total), memo || null]
    );
    await client.query("UPDATE purchase SET settlement_id = $1 WHERE settlement_id IS NULL", [s.id]);
    await client.query("COMMIT");
    return { id: s.id, total: Number(tot.total), count: Number(tot.n) };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// 지난 정산 이력
export async function getSettlements() {
  const { rows } = await pool.query(
    "SELECT id, settled_at, total_amount, memo FROM settlement ORDER BY settled_at DESC, id DESC"
  );
  return rows;
}

// 특정 정산의 구매 상세 (export용)
export async function getSettlementPurchases(id) {
  const { rows } = await pool.query(
    `SELECT code, name, vendor, unit_price, qty, unit_price * qty AS amount, purchased_at
     FROM purchase WHERE settlement_id = $1 ORDER BY purchased_at, id`,
    [id]
  );
  return rows;
}

// ── 업체 마스터 ──

// 업체 목록 (활성 먼저, 이름순)
export async function getVendors() {
  const { rows } = await pool.query("SELECT id, name, active FROM vendor ORDER BY active DESC, name");
  return rows;
}

// 업체 추가 (이름 중복이면 무시)
export async function addVendor(name, active = true) {
  const { rows } = await pool.query(
    `INSERT INTO vendor (name, active) VALUES ($1,$2)
     ON CONFLICT (name) DO NOTHING RETURNING id`,
    [String(name).trim(), active]
  );
  return { id: rows[0]?.id ?? null };
}

// 업로드 라디오 활성/비활성 토글
export async function setVendorActive(id, active) {
  await pool.query("UPDATE vendor SET active = $2 WHERE id = $1", [id, active]);
}
