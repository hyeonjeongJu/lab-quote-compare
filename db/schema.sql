-- 업체 마스터 (통제 목록) — 업로드 라디오·수동입력 셀렉트 소스
CREATE TABLE IF NOT EXISTS vendor (
  id         SERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,   -- 견적 업로드 라디오 활성(파서 검증됨). 수동입력은 활성무관 전체 사용
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO vendor (name, active) VALUES
  ('팜텍', true), ('비티비(동인)', true),
  ('삼보', false), ('에스비', false), ('코어젠', false), ('경동가스', false), ('지성문구', false)
ON CONFLICT (name) DO NOTHING;

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

-- 정산 (300만원 묶음 1건 = 정산서 1장)
CREATE TABLE IF NOT EXISTS settlement (
  id           SERIAL PRIMARY KEY,
  settled_at   DATE NOT NULL,
  total_amount INTEGER NOT NULL,              -- 정산 시점 총액 스냅샷
  memo         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 구매 한 건 = 구매 시점 값 freeze(스냅샷). offer/product 바뀌거나 지워져도 불변
CREATE TABLE IF NOT EXISTS purchase (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER REFERENCES product(id) ON DELETE SET NULL,  -- 링크용, 상품 지워도 기록 유지
  code          TEXT,                         -- freeze 스냅샷
  name          TEXT,                         -- freeze
  vendor        TEXT,                         -- freeze (산 업체)
  unit_price    INTEGER NOT NULL,             -- freeze 포장당 단가
  qty           INTEGER NOT NULL DEFAULT 1,
  purchased_at  DATE NOT NULL,
  settlement_id INTEGER REFERENCES settlement(id) ON DELETE CASCADE, -- NULL=열린 사이클, 정산되면 채워짐
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_settlement ON purchase(settlement_id);

-- updated_at 자동 갱신 (INSERT 시 default, UPDATE 시 트리거)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor','product','quote','offer','settlement','purchase'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$s
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;
