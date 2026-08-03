# EQL 6개 브랜드 모니터 + Discord 상품검색 봇

지정된 EQL 브랜드 상품을 계속 확인하고, 변경이 있을 때만 Discord Webhook으로 알림을 보냅니다. 별도의 Discord 앱은 `/상품검색` 명령어를 받아 모니터가 저장한 최신 상품 정보를 품번으로 검색합니다.

## 현재 모니터링 브랜드

| 브랜드 | EQL 브랜드 코드 |
|---|---|
| ASICS | `BDMA01E93` |
| ONITSUKA TIGER | `BDMA01Z06` |
| ARC'TERYX | `BDMA01M02` |
| ADIDAS | `BDMA01E54` |
| MONTBELL | `BDMA0195H` |
| NIKE | `BDMA01C18` |

검색어 URL이 아니라 브랜드 코드가 들어간 EQL 전용 상품 목록 주소를 사용하므로, 검색어가 들어간 다른 브랜드 상품이 섞이는 문제를 줄였습니다.

## 자동 알림

- 새 상품 등록
- 정상가·판매가·할인율 변경
- 공개 재고 수량 변경
- 판매 가능 → 품절
- 품절 → 재입고
- 공개되는 경우 옵션별 재고·품절·재입고
- 상품명, 브랜드, 품번, 가격, 재고, 이미지, 상품 URL

변동이 없으면 Discord 메시지를 보내지 않습니다. EQL이 숫자 재고를 공개하지 않는 상품은 `판매 가능`, `품절`, `품절 임박`처럼 표시됩니다.

## Discord 명령어

```text
/상품검색 품번:1203A537-100
```

검색 대상:

- 제조사 품번
- 하이픈·밑줄을 제거한 품번
- EQL 상품번호 `GM...`
- 상품명 일부

검색 결과에는 상품명, 브랜드, 품번, 정상가·판매가·할인율, 재고, 옵션별 상태, 상품 URL, 마지막 확인 시간이 표시됩니다. 최대 5개까지 보여줍니다.

## 실행 구조

```text
GitHub Actions
├─ 약 5분마다 6개 브랜드 상품 목록 확인
├─ data/state.json 갱신
└─ 변동이 있을 때만 Discord Webhook 알림

Cloudflare Worker
├─ Discord /상품검색 요청 수신
├─ data/state.json 조회
└─ 최신 저장 상품 정보를 Discord 임베드로 응답
```

브랜드 수와 상품 수가 많아 실제 실행 간격은 GitHub Actions 대기 및 수집 시간에 따라 5분보다 길어질 수 있습니다.

---

# 1. GitHub 저장소 업로드

새 저장소를 만들거나 기존 EQL 저장소의 파일을 이 압축본으로 교체합니다.

필수 구조:

```text
.github/workflows/monitor.yml
.github/workflows/deploy-bot.yml
bot-worker/
data/state.json
src/
config.json
monitor.js
package.json
```

`.github`는 숨김 폴더입니다. GitHub 웹 업로드에서 숨김 폴더가 올라가지 않으면, GitHub의 **Add file → Create new file**에서 아래 경로를 직접 만들어 내용을 붙여넣습니다.

```text
.github/workflows/monitor.yml
.github/workflows/deploy-bot.yml
```

---

# 2. Discord 자동 알림 웹훅

저장소에서 다음으로 이동합니다.

```text
Settings
→ Secrets and variables
→ Actions
→ New repository secret
```

등록:

```text
DISCORD_WEBHOOK_URL
```

웹훅 URL은 공개 저장소 파일이나 채팅에 올리지 않습니다.

---

# 3. 초기 모니터 확인

GitHub에서 다음 순서로 실행합니다.

```text
Actions
→ EQL Brand Discord Monitor
→ Run workflow
```

1. `test-webhook`: Discord 연결 확인
2. `inspect-api`: EQL 추출 결과 점검
3. `reset-baseline`: 현재 6개 브랜드 상품을 기준값으로 저장

`reset-baseline`은 초기 설치 또는 브랜드 목록을 바꾼 직후에만 실행합니다. 이후 자동 실행에서는 변동이 있을 때만 알림이 전송됩니다.

상품이 많아서 첫 기준값 저장은 일반 실행보다 오래 걸릴 수 있습니다.

---

# 4. Discord 앱과 검색 봇 생성

Discord Developer Portal에서 `New Application`으로 앱을 만든 뒤 다음 값을 준비합니다.

```text
Application ID
Public Key
Bot Token
```

설치 범위:

```text
bot
applications.commands
```

권한:

```text
Send Messages
Embed Links
Use Application Commands
```

Discord 개발자 모드를 켜고 다음 값도 복사합니다.

```text
Guild ID
Channel ID (선택)
```

---

# 5. Cloudflare Worker 준비

Cloudflare Workers 계정을 준비하고 다음 값을 확인합니다.

```text
Cloudflare Account ID
Workers Scripts: Edit 권한의 API Token
```

---

# 6. 검색 봇용 GitHub Secrets

자동 알림용 Secret 외에 다음을 등록합니다.

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
DISCORD_APPLICATION_ID
DISCORD_PUBLIC_KEY
DISCORD_BOT_TOKEN
DISCORD_GUILD_ID
DISCORD_CHANNEL_ID
STATE_JSON_URL
```

`DISCORD_CHANNEL_ID`는 특정 채널에서만 검색 명령어를 허용할 때 사용합니다.

공개 저장소의 `STATE_JSON_URL` 예시:

```text
https://raw.githubusercontent.com/GITHUB아이디/저장소이름/main/data/state.json
```

비공개 저장소의 raw 파일은 Worker가 익명으로 읽지 못하므로 현재 구성에서는 공개 저장소가 가장 간단합니다. 웹훅·봇 토큰 등의 비밀값은 GitHub Secrets에만 저장됩니다.

---

# 7. 검색 봇 배포

```text
Actions
→ Deploy EQL Discord Search Bot
→ Run workflow
```

배포 성공 후 Cloudflare Worker 주소를 Discord Developer Portal의 `Interactions Endpoint URL`에 넣습니다. 배포 Actions가 지정한 Discord 서버에 `/상품검색` 명령어도 등록합니다.

---

# 8. 사용

```text
/상품검색 품번:112619315-116
/상품검색 품번:1183C102_200
/상품검색 품번:IH8647-010
/상품검색 품번:GM0026040750345
```

검색 결과는 모니터가 마지막으로 저장한 데이터이며, 사이트가 숫자 재고를 공개하지 않으면 구매 가능·품절 상태로 표시됩니다.
