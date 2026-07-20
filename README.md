# 실험시약 견적 비교

견적서(.xls/.pdf)를 업로드하면 상품코드별로 **단위당 최저가(원/g 등)**를 비교해주는 랩실 개인 도구.

## 구조 (정적 + Vercel 함수 + Postgres)
```
index.html          업로드 폼 + 코드별 최저가 비교 테이블
api/upload.mjs       파일 raw body → parseQuote → DB 저장 (같은 파일명이면 교체)
api/comparison.mjs   비교 결과 조회
lib/parsers.mjs      규칙 기반 파서: .xls(SheetJS)/.pdf(pdf-parse) → 정규화. 규격 파싱(컬럼→코드접미사→품명) + 단위 정규화(mg/g/kg→g 등)
lib/db.mjs           pg 풀 + saveQuote(upsert product·insert offer) + getComparison(업체별 최신견적, price/spec_amount)
db/schema.sql        product · quote · offer (3테이블, offer→quote ON DELETE CASCADE)
```

## 데이터 모델
- **product**: 상품(code UNIQUE 매칭키, name, manufacturer, spec, spec_amount, spec_unit)
- **quote**: 견적서 문서(vendor, offer_date, expiration_date, offer_no, file_name)
- **offer**: 각 품목 가격(quote_id FK cascade, product_id FK, price, memo)
- 최저가 = 상품별 → (업체별 최신 quote의 offer) 중 → min(price / spec_amount)

## 규격/단위 처리
- 규격 소스 우선순위: 규격 컬럼 → 코드 접미사(`PHR1423-1G`→1g) → 품명("...25 g")
- 단위 정규화: mg/g/kg→g, ml/l→ml, ea → 원/base 비교. 못 쪼개면 spec_amount NULL → 총액 비교 폴백
- 발행일+7일 = 만료일, 오늘 지나면 UI에 "만료" 표시

## 배포 (Vercel + Neon Postgres, 무료)
1. GitHub push → Vercel에 Import(프리셋 Other)
2. Vercel → Storage → **Postgres(Neon)** 생성 → 프로젝트 Connect (POSTGRES_URL 자동 주입) → Redeploy
3. `db/schema.sql`을 Neon SQL 에디터(또는 psql)에서 1회 실행
4. 앱 열어 견적서 업로드

## 주의
- 개인/랩실용(비상업). 정산 기능은 다음 증분(order/settlement 테이블 예정)
- 새 업체 견적 포맷은 파서 규칙 추가가 필요할 수 있음(규칙 기반)
- pg 타입 함정 처리됨: DATE→문자열(setTypeParser 1082), NUMERIC은 프론트에서 Number() 변환

## 로컬 개발
```bash
# 임시 Postgres
docker run -d --name labpg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=lab -p 55432:5432 postgres:16
export POSTGRES_URL="postgres://postgres:pw@localhost:55432/lab"
node -e "import('pg').then(async({default:pg})=>{const p=new pg.Pool({connectionString:process.env.POSTGRES_URL});await p.query(require('fs').readFileSync('db/schema.sql','utf8'));await p.end()})"
```
