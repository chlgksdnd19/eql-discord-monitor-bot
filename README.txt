EQL 모니터 v3 수정 파일

현재 inspect-api가 상품 0개로 끝나는 문제를 수정합니다.

교체할 파일:
1. config.json
2. src/scraper.js
3. src/extractors.js

변경 내용:
- 작동하지 않는 /display/productsList 주소 대신 EQL 검색 결과 페이지 사용
- 현재 EQL 상품 URL의 GP... 상품번호 인식
- 검색 결과의 더 보기 버튼을 눌러 상품 링크 확장
- 0개 추출 시 debug HTML/PNG를 Artifacts에 저장

교체 후 Actions에서 inspect-api를 다시 실행하세요.
reset-baseline은 상품 개수가 0보다 크게 나온 뒤에만 실행하세요.
