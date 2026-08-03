# EQL Discord Search Bot Worker

Cloudflare Worker에서 Discord `/상품검색` 명령을 처리합니다. 전체 설치 과정은 저장소 루트의 `README.md`를 따르세요.

필수 Worker Secrets:

```text
DISCORD_PUBLIC_KEY
STATE_JSON_URL
ALLOWED_GUILD_ID
ALLOWED_CHANNEL_ID (선택)
```

명령어 등록 스크립트 환경 변수:

```text
DISCORD_BOT_TOKEN
DISCORD_APPLICATION_ID
DISCORD_GUILD_ID
```
