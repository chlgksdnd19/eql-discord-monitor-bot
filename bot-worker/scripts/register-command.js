const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token) throw new Error('DISCORD_BOT_TOKEN이 필요합니다.');
if (!applicationId) throw new Error('DISCORD_APPLICATION_ID가 필요합니다.');
if (!guildId) throw new Error('DISCORD_GUILD_ID가 필요합니다.');

const commands = [{
  name: '상품검색',
  description: 'EQL 상품을 품번으로 검색하고 공개 재고를 실시간 확인합니다.',
  type: 1,
  options: [{
    name: '품번',
    description: '제조사 품번 또는 EQL 상품번호(GP/GM…)를 입력하세요.',
    type: 3,
    required: true,
    min_length: 2,
    max_length: 80
  }]
}];

const endpoint = `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`;
const response = await fetch(endpoint, {
  method: 'PUT',
  headers: {
    authorization: `Bot ${token}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify(commands)
});

const body = await response.text();
if (!response.ok) throw new Error(`명령어 등록 실패 (${response.status}): ${body}`);
console.log('Discord /상품검색 명령어 등록 완료');
console.log(body);
