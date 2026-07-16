-- 상품 카탈로그 (유지)
CREATE TABLE IF NOT EXISTS product (
  id           SERIAL PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,       -- 상품코드(매칭 키)
  name         TEXT,
  manufacturer TEXT,
  spec         TEXT,                        -- 규격 원문 "25 g"
  spec_amount  NUMERIC,                     -- 기준단위 수량 (25) / 못 쪼개면 NULL
  spec_unit    TEXT,                        -- 기준단위 g/ml/ea
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 견적서 문서 (한 업로드 = 한 행)
CREATE TABLE IF NOT EXISTS quote (
  id              SERIAL PRIMARY KEY,
  vendor          TEXT,
  offer_date      DATE,                     -- 발행일(파일에서 파싱)
  expiration_date DATE,                     -- 만료일(발행일+유효기간)
  offer_no        TEXT,                     -- 견적서 번호
  file_name       TEXT,                     -- 업로드 파일명
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 각 품목 가격(줄) — product↔quote 교차, 가격 보유
CREATE TABLE IF NOT EXISTS offer (
  id         SERIAL PRIMARY KEY,
  quote_id   INTEGER NOT NULL REFERENCES quote(id) ON DELETE CASCADE,  -- 견적서 지우면 같이 삭제
  product_id INTEGER NOT NULL REFERENCES product(id),
  price      INTEGER NOT NULL,              -- 포장당 가격(단가)
  memo       TEXT,                          -- 비고(소요기간·재고 등)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offer_product ON offer(product_id);
CREATE INDEX IF NOT EXISTS idx_offer_quote   ON offer(quote_id);

-- updated_at 자동 갱신 (INSERT 시 default, UPDATE 시 트리거)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product','quote','offer'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$s
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;
