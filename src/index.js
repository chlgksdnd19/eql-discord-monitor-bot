const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5
};
const InteractionResponseFlags = { EPHEMERAL: 64 };
import { fetchLiveStock, applyLiveStock } from './live-stock.js';
import { productToEmbed, searchProducts } from './search.js';

const COMMAND_NAME = '상품검색';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') {
      return Response.json({ ok: true, service: 'EQL Discord product search bot', liveStock: true });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
      return new Response('Missing Discord signature information', { status: 401 });
    }

    const rawBody = await request.text();
    const valid = await verifyDiscordRequest(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response('Bad request signature', { status: 401 });

    const interaction = JSON.parse(rawBody);
    if (interaction.type === InteractionType.PING) {
      return json({ type: InteractionResponseType.PONG });
    }
    if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
      return interactionMessage('지원하지 않는 요청입니다.', true);
    }

    if (env.ALLOWED_GUILD_ID && interaction.guild_id !== env.ALLOWED_GUILD_ID) {
      return interactionMessage('이 봇은 지정된 디스코드 서버에서만 사용할 수 있습니다.', true);
    }
    if (env.ALLOWED_CHANNEL_ID && interaction.channel_id !== env.ALLOWED_CHANNEL_ID) {
      return interactionMessage('지정된 EQL 검색 채널에서만 명령어를 사용할 수 있습니다.', true);
    }
    if (interaction.data?.name !== COMMAND_NAME) {
      return interactionMessage('등록되지 않은 명령어입니다.', true);
    }

    const query = interaction.data.options?.find((option) => option.name === '품번')?.value;
    if (!query) return interactionMessage('검색할 품번을 입력해 주세요.', true);

    ctx.waitUntil(handleProductSearch(interaction, env, query));
    return json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { allowed_mentions: { parse: [] } }
    });
  }
};

async function handleProductSearch(interaction, env, query) {
  try {
    const state = await loadState(env.STATE_JSON_URL);
    const results = searchProducts(state, query, 5);
    if (!results.length) {
      await editOriginal(interaction, {
        content: `선택 브랜드의 최신 모니터링 데이터에서 **${escapeMarkdown(query)}** 품번을 찾지 못했습니다. EQL 상품번호(GP/GM…) 또는 제조사 품번을 확인해 주세요.`,
        embeds: [],
        allowed_mentions: { parse: [] }
      });
      return;
    }

    const enriched = [];
    for (let index = 0; index < results.length; index += 1) {
      const product = results[index];
      if (index === 0) {
        const live = await fetchLiveStock(product);
        enriched.push(applyLiveStock(product, live));
      } else {
        enriched.push(product);
      }
    }

    await editOriginal(interaction, {
      content: enriched.length > 1 ? `**${escapeMarkdown(query)}** 검색 결과 ${enriched.length}개 · 첫 번째 상품은 실시간 재고 확인` : undefined,
      embeds: enriched.map((product) => productToEmbed(product, state)),
      allowed_mentions: { parse: [] }
    });
  } catch (error) {
    console.error(error);
    await editOriginal(interaction, {
      content: '상품 또는 실시간 재고 데이터를 불러오지 못했습니다. 잠시 후 다시 실행해 주세요.',
      embeds: [],
      allowed_mentions: { parse: [] }
    });
  }
}

async function editOriginal(interaction, body) {
  const endpoint = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Discord 응답 수정 실패 (${response.status}): ${detail}`);
  }
}

async function verifyDiscordRequest(body, signatureHex, timestamp, publicKeyHex) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const data = new TextEncoder().encode(`${timestamp}${body}`);
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex), data);
  } catch (error) {
    console.error('Discord signature verification failed', error);
    return false;
  }
}

function hexToBytes(value) {
  const text = String(value || '').trim();
  if (!/^[0-9a-f]+$/i.test(text) || text.length % 2 !== 0) throw new Error('Invalid hex input');
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < text.length; index += 2) {
    bytes[index / 2] = Number.parseInt(text.slice(index, index + 2), 16);
  }
  return bytes;
}

async function loadState(url) {
  if (!url) throw new Error('STATE_JSON_URL이 설정되지 않았습니다.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('STATE_JSON_URL은 HTTPS 주소여야 합니다.');

  const response = await fetch(parsed.href, {
    headers: { accept: 'application/json', 'user-agent': 'EQL-Discord-Search-Bot/2.0' },
    cf: { cacheTtl: 30, cacheEverything: false }
  });
  if (!response.ok) throw new Error(`상태 파일 조회 실패: ${response.status}`);
  const state = await response.json();
  if (!state || typeof state !== 'object' || !state.products) throw new Error('상태 파일 형식이 올바르지 않습니다.');
  return state;
}

function interactionMessage(content, ephemeral) {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: ephemeral ? InteractionResponseFlags.EPHEMERAL : undefined,
      allowed_mentions: { parse: [] }
    }
  });
}

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) }
  });
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/([\\`*_{}\[\]()<>#+\-.!|>])/g, '\\$1').slice(0, 100);
}
