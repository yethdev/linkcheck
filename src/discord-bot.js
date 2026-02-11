import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { checkAllFilters } from './native-checker.js';

const PLATFORM_ORDER = [
  'ContentKeeper', 'Lightspeed', 'Securly', 'AristotleK12', 'Senso Cloud',
  'Linewize', 'Cisco Umbrella', 'iBoss', 'Palo Alto', 'LanSchool',
  'Blocksi Web', 'FortiGuard', 'GoGuardian', 'Blocksi AI', 'Deledao',
];

class SlidingWindow {
  constructor(limit, windowMs) {
    this._limit = limit;
    this._windowMs = windowMs;
    this._store = new Map();
  }

  hit(key) {
    const now = Date.now();
    const cutoff = now - this._windowMs;
    let stamps = this._store.get(key) || [];
    stamps = stamps.filter(t => t > cutoff);
    if (stamps.length >= this._limit) {
      this._store.set(key, stamps);
      const wait = stamps[0] + this._windowMs - now;
      return { ok: false, wait };
    }
    stamps.push(now);
    this._store.set(key, stamps);
    return { ok: true };
  }

  prune() {
    const cutoff = Date.now() - this._windowMs;
    for (const [key, stamps] of this._store) {
      const live = stamps.filter(t => t > cutoff);
      if (live.length === 0) this._store.delete(key);
      else this._store.set(key, live);
    }
  }
}

function cleanUrl(raw) {
  let u = raw.trim();
  if (!u) return null;
  if (u.length > 2048) return null;
  u = u.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!u || u.includes(' ') || u.includes('<') || u.includes('>')) return null;
  if (!/[a-zA-Z0-9]/.test(u)) return null;
  return u;
}

function statusIcon(s) {
  if (s === 'blocked') return '\u274C';
  if (s === 'unblocked') return '\u2705';
  return '\u26A0\uFE0F';
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('check')
      .setDescription('Check a URL across all filter databases')
      .addStringOption(o =>
        o.setName('url').setDescription('URL to look up').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Latency'),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('List available commands'),
  ].map(c => c.toJSON());
}

export async function startDiscordBot(opts = {}) {
  const token = opts.token || process.env.DISCORD_BOT_TOKEN;
  const clientId = opts.clientId || process.env.DISCORD_CLIENT_ID;
  const rateLimitEnabled = opts.rateLimitEnabled !== undefined ? opts.rateLimitEnabled : (process.env.BOT_RATE_LIMIT !== 'false');
  const rateLimitMax = opts.rateLimitMax || Number(process.env.BOT_RATE_LIMIT_MAX || 100);
  const rateLimitWindowMs = 60_000;

  if (!token) {
    console.error('DISCORD_BOT_TOKEN is required for the Discord bot.');
    process.exit(1);
  }
  if (!clientId) {
    console.error('DISCORD_CLIENT_ID is required for command registration.');
    process.exit(1);
  }

  const limiter = new SlidingWindow(rateLimitMax, rateLimitWindowMs);
  setInterval(() => limiter.prune(), 30_000);

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: buildCommands() });
  console.log('[bot] slash commands registered');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', () => {
    console.log('[bot] online as ' + client.user.tag);
  });

  client.on('interactionCreate', async (ix) => {
    if (!ix.isChatInputCommand()) return;

    if (ix.commandName === 'ping') {
      const ws = client.ws.ping;
      const sent = Date.now();
      await ix.reply({ content: ws + 'ms', ephemeral: false });
      return;
    }

    if (ix.commandName === 'help') {
      await ix.reply({
        content: [
          '`/check url:<url>` — look up a URL across all filter databases',
          '`/ping` — bot latency',
          '`/help` — this list',
        ].join('\n'),
        ephemeral: false,
      });
      return;
    }

    if (ix.commandName === 'check') {
      const rawUrl = ix.options.getString('url', true);
      const url = cleanUrl(rawUrl);
      if (!url) {
        await ix.reply({ content: 'Invalid URL.', ephemeral: true });
        return;
      }

      if (rateLimitEnabled) {
        const rl = limiter.hit(ix.user.id);
        if (!rl.ok) {
          const secs = Math.ceil(rl.wait / 1000);
          await ix.reply({ content: 'Rate limited. Try again in ' + secs + 's.', ephemeral: true });
          return;
        }
      }

      await ix.deferReply();

      const results = new Map();
      try {
        await checkAllFilters(url, (r) => {
          results.set(r.name, r);
        });
      } catch {
        await ix.editReply('Check failed for `' + url + '`.');
        return;
      }

      const lines = [];
      for (const name of PLATFORM_ORDER) {
        const r = results.get(name);
        if (!r) {
          lines.push('**' + name + '**\n\u26A0\uFE0F No response');
          continue;
        }
        lines.push('**' + name + '**\n' + statusIcon(r.status) + ' ' + r.category);
      }

      const blocked = [...results.values()].filter(r => r.status === 'blocked').length;
      const total = results.size;

      const embed = new EmbedBuilder()
        .setTitle(url)
        .setDescription(lines.join('\n'))
        .setFooter({ text: blocked + '/' + total + ' blocked' })
        .setColor(blocked > 0 ? 0xef4444 : 0x22c55e);

      await ix.editReply({ embeds: [embed] });
    }
  });

  await client.login(token);
  return client;
}
