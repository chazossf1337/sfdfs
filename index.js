require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

// Real-time mode: delete non-video messages as soon as they're posted.
// Off by default — run !scanvideos manually unless you turn this on.
const REALTIME = process.env.REALTIME_MODE === 'true';

// When set, real-time deletion and the startup sweep only apply to this
// channel. !scanvideos still works in any channel regardless of this setting.
const CHANNEL_ID = process.env.CHANNEL_ID || null;

// How many existing messages to sweep through on startup for CHANNEL_ID.
// Default: entire history.
const STARTUP_SCAN_LIMIT = process.env.STARTUP_SCAN_LIMIT
  ? parseInt(process.env.STARTUP_SCAN_LIMIT, 10)
  : Infinity;

if (REALTIME && !CHANNEL_ID) {
  console.error('REALTIME_MODE is on but CHANNEL_ID is not set in .env — refusing to start (this would nuke non-video messages server-wide).');
  process.exit(1);
}

const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|avi|mkv|m4v|wmv)$/i;
const VIDEO_URL_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch/i,
  /(?:https?:\/\/)?(?:www\.)?youtu\.be\//i,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\//i,
  /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/.+\/video\//i,
  /(?:https?:\/\/)?(?:vm|vt)\.tiktok\.com\//i,
  /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(reel|reels|tv)\//i,
  /(?:https?:\/\/)?(?:clips\.)?twitch\.tv\//i,
  /(?:https?:\/\/)?(?:www\.)?streamable\.com\//i,
  /(?:https?:\/\/)?(?:www\.)?medal\.tv\//i,
  /(?:https?:\/\/)?(?:www\.)?kick\.com\/.+\/clips?\//i,
  /(?:https?:\/\/)?(?:x|twitter)\.com\/.+\/(video|status)\//i,
];

function messageHasVideo(message) {
  for (const attachment of message.attachments.values()) {
    if (attachment.contentType && attachment.contentType.startsWith('video/')) return true;
    if (VIDEO_EXTENSIONS.test(attachment.name || attachment.url)) return true;
  }

  for (const embed of message.embeds) {
    if (embed.video) return true;
    if (embed.type === 'video') return true;
  }

  if (message.content) {
    for (const pattern of VIDEO_URL_PATTERNS) {
      if (pattern.test(message.content)) return true;
    }
  }

  return false;
}

// Scans up to `limit` messages in `channel` (walking backward in time from
// the most recent) and deletes every non-video, non-bot message found.
// Returns { scanned, deleted }.
async function scanAndPurge(channel, limit = Infinity, { log = false, startBeforeId = null } = {}) {
  let scanned = 0;
  let deleted = 0;
  let beforeId = startBeforeId;
  const toDeleteIndividually = [];
  const bulkDeletable = [];
  const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

  while (scanned < limit) {
    const batchSize = Math.min(100, limit - scanned);
    const fetchOptions = { limit: batchSize };
    if (beforeId) fetchOptions.before = beforeId;
    const batch = await channel.messages.fetch(fetchOptions);
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      scanned++;
      if (msg.author.bot) continue;
      if (messageHasVideo(msg)) continue;

      if (msg.createdTimestamp > fourteenDaysAgo) {
        bulkDeletable.push(msg);
      } else {
        toDeleteIndividually.push(msg);
      }
    }

    beforeId = batch.last().id;
    if (batch.size < batchSize) break;
  }

  for (let i = 0; i < bulkDeletable.length; i += 100) {
    const chunk = bulkDeletable.slice(i, i + 100);
    try {
      const result = await channel.bulkDelete(chunk, true);
      deleted += result.size;
    } catch (err) {
      console.error('Bulk delete failed:', err.message);
    }
  }

  for (const msg of toDeleteIndividually) {
    try {
      await msg.delete();
      deleted++;
      if (log) console.log(`[DELETED-OLD] ${msg.author.tag}: ${(msg.content || '[no text]').slice(0, 60)}`);
    } catch (err) {
      console.error('Failed to delete old message:', err.message);
    }
  }

  if (log) console.log(`Sweep done: scanned ${scanned}, deleted ${deleted}.`);
  return { scanned, deleted };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (REALTIME) {
    console.log(`Real-time mode is ON for channel ${CHANNEL_ID} — non-video messages there will be deleted as they arrive.`);
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      console.log(`Sweeping existing messages in #${channel.name || CHANNEL_ID}...`);
      await scanAndPurge(channel, STARTUP_SCAN_LIMIT, { log: true });
    } catch (err) {
      console.error('Startup sweep failed:', err.message);
    }
  }
});

// !scanvideos [count]  — scans the last `count` messages (default 100, max 1000)
// in the channel the command is run in, and deletes every message that
// doesn't contain a video. Requires Manage Messages.
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (REALTIME && message.guild && message.channel.id === CHANNEL_ID) {
    const preview = (message.content || '[no text]').slice(0, 60);
    if (messageHasVideo(message)) {
      console.log(`[KEEP] ${message.author.tag}: ${preview}`);
    } else {
      console.log(`[DELETE] ${message.author.tag}: ${preview}`);
      message.delete()
        .then(() => console.log(`[DELETED] ${message.author.tag}: ${preview}`))
        .catch((err) => console.error('Failed to delete message:', err.message));
    }
    return;
  }

  if (!message.content.startsWith('!scanvideos')) return;
  if (!message.guild) return;

  const member = await message.guild.members.fetch(message.author.id);
  if (!member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    return message.reply('You need the Manage Messages permission to run this.');
  }

  const args = message.content.trim().split(/\s+/);
  const requested = parseInt(args[1], 10);
  const limit = Math.min(Math.max(Number.isNaN(requested) ? 100 : requested, 1), 1000);

  const statusMsg = await message.reply(`Scanning last ${limit} messages for non-video content...`);
  const { scanned, deleted } = await scanAndPurge(message.channel, limit, { startBeforeId: message.id });
  await statusMsg.edit(`Scanned ${scanned} message(s), deleted ${deleted} without a video.`);
});

client.login(TOKEN);
