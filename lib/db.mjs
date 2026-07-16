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
