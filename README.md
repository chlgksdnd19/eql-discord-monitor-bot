# EQL Discord Monitor + 상품검색 봇 v6

선택한 6개 EQL 브랜드를 GitHub Actions에서 약 5분마다 확인하고, 상품 변동이 있을 때만 Discord 웹훅으로 알립니다. 상품 데이터는 `data/state.json`에 저장되며 기존 Cloudflare Worker 기반 `/상품검색` 봇이 그대로 사용합니다.

## 모니터링 브랜드

- ASICS
- ONITSUKA TIGER
- ARC'TERYX
- ADIDAS
- MONTBELL
- NIKE

## 알림 항목

- 새 상품 등록
- 판매가·정상가·할인율 변경
- 공개 재고 수량 변경
- 판매 가능 → 품절
- 품절 → 재입고
- 순환 상세 확인에서 발견한 옵션별 품절·재입고·공개 수량
- 상품명, 브랜드, 품번, 금액, 재고, 상품 URL

변동이 없으면 Discord 메시지를 보내지 않습니다.

## v6의 핵심 변경

기존 버전은 한 GitHub Runner가 6개 브랜드를 연속으로 열어 세 번째 이후 브랜드에서 EQL 접근 제한이 발생했습니다. v6는 브랜드별 독립 수집 작업 6개로 분리하고, 시작 시각을 20초 간격으로 분산합니다. 각 수집 결과는 artifact로 전달된 뒤 마지막 병합 작업이 한 번만 상태 비교·웹훅 전송·`state.json` 저장을 수행합니다.

특정 브랜드만 일시적으로 실패하면 그 브랜드의 기존 저장값을 유지하며, 다른 브랜드 모니터링은 계속됩니다. 최초 기준값 저장과 수동 `reset-baseline`은 6개 브랜드가 모두 성공한 경우에만 완료됩니다.

## GitHub Secret

자동 알림:

- `DISCORD_WEBHOOK_URL`

상품검색 봇 배포 시 추가:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`
- `DISCORD_APPLICATION_ID`
- `DISCORD_GUILD_ID`
- `DISCORD_CHANNEL_ID` (선택)
- `STATE_JSON_URL`

공개 저장소에서 `STATE_JSON_URL` 예시:

```text
https://raw.githubusercontent.com/사용자명/eql-discord-monitor-bot/main/data/state.json
```

## Actions 실행 순서

1. `test-webhook`: 웹훅 연결 확인
2. `inspect-api`: 6개 브랜드 병렬 수집 검사
3. `reset-baseline`: 현재 상품을 기준값으로 한 번 저장
4. 이후 예약 실행은 자동 `monitor`

`inspect-api` 정상 로그 예시:

```text
ASICS: 상품 80개, 상세 0개, 성공
...
병렬 점검 완료: 성공 6/6개 브랜드, 상품 500개
```

## 상품검색 봇

자동 모니터가 기준값을 저장한 뒤 Cloudflare Worker를 배포하면 Discord에서 다음 명령어를 사용할 수 있습니다.

```text
/상품검색 품번:112619320-400
/상품검색 품번:GP9026020423225
```

상품명, 브랜드, 제조사 품번, EQL 상품번호, 금액, 재고, 옵션 상태, URL, 마지막 확인 시간을 표시합니다.

## 공개 재고의 한계

EQL이 숫자 재고를 공개한 경우에만 수량을 표시합니다. 숫자를 공개하지 않은 상품은 `판매 가능`, `품절`, `품절 임박` 등의 공개 상태만 저장하며 수량을 추정하지 않습니다.
