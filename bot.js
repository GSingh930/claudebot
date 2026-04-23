const { Client, GatewayIntentBits, Events, ChannelType } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const XLSX = require('xlsx');
const https = require('https');
const http = require('http');
const {
  isAllowlisted,
  getLimits,
  checkLimit,
  recordUsage,
  getUsageSummary,
  startCleanupJob,
  ALLOWED_USER_IDS,
} = require('./usageTracker');

// ── Config ─────────────────────────────────────────────────────────────────
const config = {
  discordToken:    process.env.DISCORD_TOKEN    || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  prefix:          process.env.PREFIX           || '!claude',
  systemPrompt:    process.env.SYSTEM_PROMPT    || 'You are a helpful, friendly assistant. Be concise, clear, and engaging. Use Discord markdown when helpful.',
  botName:         process.env.BOT_NAME         || 'ClaudeBot',
  allowedChannels: process.env.ALLOWED_CHANNELS
    ? process.env.ALLOWED_CHANNELS.split(',').map(s => s.trim()).filter(Boolean)
    : [],
};

// ── Discord client ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.DirectMessageTyping,
  ],
  partials: ['CHANNEL', 'MESSAGE'],
});

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// ── History stores ─────────────────────────────────────────────────────────
// Guild channels — may be referenced by dashboard for stats
const conversationHistory = new Map();

// DMs — NEVER exported, NEVER visible to dashboard
const dmHistory = new Map();

function getChannelSession(channelId) {
  if (!conversationHistory.has(channelId)) {
    conversationHistory.set(channelId, { messages: [], lastActivity: Date.now() });
  }
  const s = conversationHistory.get(channelId);
  s.lastActivity = Date.now();
  return s;
}

function getDMSession(userId) {
  if (!dmHistory.has(userId)) {
    dmHistory.set(userId, { messages: [], lastActivity: Date.now() });
  }
  const s = dmHistory.get(userId);
  s.lastActivity = Date.now();
  return s;
}

function addToSession(session, role, content) {
  session.messages.push({ role, content });
  if (session.messages.length > 20) session.messages.splice(0, session.messages.length - 20);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function downloadAttachment(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseExcelToText(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return wb.SheetNames.map(n => `\n=== Sheet: ${n} ===\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}\n`).join('');
}

function splitMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, maxLength);
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline > maxLength * 0.7) chunk = remaining.slice(0, lastNewline);
    parts.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return parts;
}

// ── Claude calls ───────────────────────────────────────────────────────────
async function chatWithClaude(session, userMessage, maxTokens) {
  addToSession(session, 'user', userMessage);
  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system:     config.systemPrompt,
    messages:   session.messages,
  });
  const reply = response.content[0].text;
  const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
  addToSession(session, 'assistant', reply);
  return { reply, tokensUsed };
}

async function generateVBAScript(excelContent, userPrompt, maxTokens) {
  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system:     'You are an expert VBA developer for Microsoft Excel. Write clean, well-commented VBA macros. Always wrap VBA code in ```vba code blocks. Explain usage.',
    messages:   [{ role: 'user', content: `Excel data:\n\n${excelContent}\n\nTask: ${userPrompt}` }],
  });
  const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
  return { result: response.content[0].text, tokensUsed };
}

// ── Core message handler ───────────────────────────────────────────────────
async function handleMessage(message, isDM) {
  const userId = message.author.id;

  // Gate: check daily token budget
  const limitCheck = checkLimit(userId);
  if (!limitCheck.allowed) {
    await message.reply(limitCheck.reason);
    return;
  }

  const limits = getLimits(userId);

  const userInput = isDM
    ? message.content.trim()
    : message.content
        .replace(new RegExp(`<@!?${client.user.id}>`), '')
        .replace(config.prefix, '')
        .trim();

  // ── Excel → VBA ──
  const excelAttachment = message.attachments.find(a => /\.(xlsx|xls|csv)$/i.test(a.name));

  if (excelAttachment) {
    await message.channel.sendTyping();
    try {
      const buffer       = await downloadAttachment(excelAttachment.url);
      const excelContent = parseExcelToText(buffer);
      const prompt       = userInput || 'Analyze this spreadsheet and suggest useful VBA automations.';

      await message.reply(`📊 Processing \`${excelAttachment.name}\`…`);

      const { result, tokensUsed } = await generateVBAScript(excelContent, prompt, limits.maxTokensPerRequest);
      recordUsage(userId, tokensUsed);

      for (const part of splitMessage(result)) await message.channel.send(part);

      if (!isAllowlisted(userId)) {
        const s = getUsageSummary(userId);
        await message.channel.send(`> 📊 Token budget: **${s.used}/${s.budget}** used today`);
      }
    } catch (err) {
      console.error('[VBA error]', err);
      await message.reply('❌ Error processing the file. Make sure it\'s a valid .xlsx/.xls/.csv.');
    }
    return;
  }

  // ── Usage command ──
  if (!userInput || ['usage', '!usage', 'help'].includes(userInput.toLowerCase())) {
    const s = getUsageSummary(userId);
    await message.reply(
      `**${isDM ? '🤖 ClaudeBot DM' : '👋 Hi!'}**\n` +
      `Ask me anything, or attach an Excel file for a VBA script.\n\n` +
      `**Your token budget today:**\n` +
      `${s.tier} · ${s.used}/${s.budget} tokens (${s.pct}% used) · Resets midnight UTC`
    );
    return;
  }

  // ── Regular chat ──
  await message.channel.sendTyping();
  try {
    const session = isDM ? getDMSession(userId) : getChannelSession(message.channelId);
    const { reply, tokensUsed } = await chatWithClaude(session, userInput, limits.maxTokensPerRequest);
    recordUsage(userId, tokensUsed);

    const parts = splitMessage(reply);
    await message.reply(parts[0]);
    for (let i = 1; i < parts.length; i++) await message.channel.send(parts[i]);

    if (!isAllowlisted(userId)) {
      const s = getUsageSummary(userId);
      if (s.pct >= 80) {
        await message.channel.send(`> ⚠️ Token budget: **${s.used}/${s.budget}** — ${100 - s.pct}% remaining today`);
      }
    }
  } catch (err) {
    console.error('[Chat error]', err);
    await message.reply('❌ Something went wrong. Please try again.');
  }
}

// ── Events ─────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  console.log(`📡 Prefix: ${config.prefix} | Channels: ${config.allowedChannels.length || 'ALL'}`);
  console.log(`🔑 Allowlisted users: ${ALLOWED_USER_IDS.size}`);
  startCleanupJob(conversationHistory, dmHistory);
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;

  if (isDM) {
    // DMs: no prefix needed — every message is addressed to the bot
    await handleMessage(message, true);
    return;
  }

  // Guild: require prefix or mention
  const isMentioned = message.mentions.has(client.user);
  const hasPrefix   = message.content.startsWith(config.prefix);
  if (!isMentioned && !hasPrefix) return;

  if (config.allowedChannels.length > 0 && !config.allowedChannels.includes(message.channelId)) return;

  await handleMessage(message, false);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'clear') {
    const isDM = interaction.channel?.type === ChannelType.DM;
    if (isDM) dmHistory.delete(interaction.user.id);
    else conversationHistory.delete(interaction.channelId);
    await interaction.reply({ content: '🧹 Conversation history cleared!', ephemeral: true });
  }
});

module.exports = {
  client,
  conversationHistory, // guild-only — dashboard may read for stats
  // dmHistory intentionally NOT exported — private by design
  startBot: () => client.login(config.discordToken),
};
