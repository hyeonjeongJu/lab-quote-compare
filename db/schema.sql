-- 업체 마스터 (통제 목록) — 업로드 라디오·수동입력 셀렉트 소스
CREATE TABLE IF NOT EXISTS vendor (
  id         SERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,    -- 견적 업로드 라디오 노출(파서 검증됨). 수동입력은 활성무관 전체 사용
  builtin    BOOLEAN NOT NULL DEFAULT false,   -- 기본 등록 업체 = 삭제 불가
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE vendor ADD COLUMN IF NOT EXISTS builtin BOOLEAN NOT NULL DEFAULT false;   -- 기존 DB 보강
INSERT INTO vendor (name, active, builtin) VALUES
  ('팜텍', true, true), ('비티비(동인)', true, true),
  ('삼보', false, true), ('에스비', false, true), ('코어젠', false, true), ('경동가스', false, true), ('지성문구', false, true)
ON CONFLICT (name) DO NOTHING;
UPDATE vendor SET builtin = true
  WHERE name IN ('팜텍','비티비(동인)','삼보','에스비','코어젠','경동가스','지성문구') AND builtin = false;

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
  delivered_at  DATE,                         -- 납품일(추후 줄마다 직접 기록)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS delivered_at DATE;   -- 기존 DB 보강

-- 정산 기록(외상장부 credit) — 업체별 갚은 금액. 구매줄과 링크하지 않음(미정산=구매합−정산합)
CREATE TABLE IF NOT EXISTS settlement (
  id         SERIAL PRIMARY KEY,
  vendor     TEXT NOT NULL,
  amount     INTEGER NOT NULL,             -- 정산(결제)한 금액
  settled_at DATE NOT NULL,                -- 정산일
  memo       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_settlement_vendor ON settlement(vendor);
-- 구(舊) 정산-구매 링크 잔재 정리(있으면)
ALTER TABLE purchase DROP COLUMN IF EXISTS settlement_id;
DROP INDEX IF EXISTS idx_purchase_settlement;

-- updated_at 자동 갱신 (INSERT 시 default, UPDATE 시 트리거)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor','product','quote','offer','purchase','settlement'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$s
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;
