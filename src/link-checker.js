import chalk from 'chalk';
import ora from 'ora';
import { DiscordAutomation } from './discord-automation.js';

export class LinkChecker {
  constructor(config) {
    this.config = config;
    this.discord = new DiscordAutomation({
      token: config.token,
      channelId: config.channelId,
      targetBotId: config.targetBotId,
      replyTimeout: config.replyTimeout,
      headless: config.headless,
    });
    this.results = [];
  }

  async init() {
    const spinner = ora('Launching browser & authenticating with Discord...').start();
    try {
      await this.discord.launch();
      spinner.succeed('Connected to Discord');
    } catch (err) {
      spinner.fail('Failed to connect to Discord');
      throw err;
    }
  }

  async destroy() {
    await this.discord.close();
  }

  async checkLink(url, prefix = '') {
    const message = prefix ? `${prefix}${url}` : url;
    const spinner = ora(`Checking ${chalk.cyan(url)}…`).start();

    try {
      const reply = await this.discord.sendAndAwaitReply(message);
      const status = this._parseReply(reply);

      const result = { url, status, reply: reply.text, embeds: reply.embeds };
      this.results.push(result);

      if (status === 'safe') {
        spinner.succeed(`${chalk.cyan(url)} → ${chalk.green('SAFE')}`);
      } else if (status === 'unsafe') {
        spinner.fail(`${chalk.cyan(url)} → ${chalk.red('UNSAFE')}`);
      } else {
        spinner.warn(`${chalk.cyan(url)} → ${chalk.yellow('UNKNOWN')}`);
      }

      return result;
    } catch (err) {
      const result = { url, status: 'error', reply: null, error: err.message };
      this.results.push(result);
      spinner.fail(`${chalk.cyan(url)} → ${chalk.red('ERROR')}: ${err.message}`);
      return result;
    }
  }

  async checkLinks(urls, prefix = '', delayMs = 2000) {
    const results = [];
    for (let i = 0; i < urls.length; i++) {
      const result = await this.checkLink(urls[i], prefix);
      results.push(result);

      // Throttle to avoid Discord rate limits
      if (i < urls.length - 1) {
        await this._sleep(delayMs);
      }
    }
    return results;
  }

  async sendRaw(message) {
    return this.discord.sendAndAwaitReply(message);
  }

  async sendRawStreaming(message, onUpdate, timeout) {
    return this.discord.sendAndStreamReply(message, onUpdate, timeout);
  }

  async screenshot(path = 'screenshots/debug.png') {
    await this.discord.screenshot(path);
  }

  getSummary() {
    const total = this.results.length;
    const safe = this.results.filter((r) => r.status === 'safe').length;
    const unsafe = this.results.filter((r) => r.status === 'unsafe').length;
    const unknown = this.results.filter((r) => r.status === 'unknown').length;
    const errors = this.results.filter((r) => r.status === 'error').length;

    return { total, safe, unsafe, unknown, errors, results: this.results };
  }

  printSummary() {
    const s = this.getSummary();
    console.log('\n' + chalk.bold('═══ Link Check Summary ═══'));
    console.log(`  Total:   ${s.total}`);
    console.log(`  ${chalk.green('Safe:')}    ${s.safe}`);
    console.log(`  ${chalk.red('Unsafe:')}  ${s.unsafe}`);
    console.log(`  ${chalk.yellow('Unknown:')} ${s.unknown}`);
    console.log(`  ${chalk.red('Errors:')}  ${s.errors}`);
    console.log(chalk.bold('══════════════════════════\n'));

    // Detail table
    if (s.results.length > 0) {
      console.log(chalk.bold('Details:'));
      for (const r of s.results) {
        const icon =
          r.status === 'safe'    ? chalk.green('✔') :
          r.status === 'unsafe'  ? chalk.red('✘') :
          r.status === 'error'   ? chalk.red('⚠') :
                                   chalk.yellow('?');
        const detail = r.reply ? ` — ${r.reply.substring(0, 100)}` : '';
        console.log(`  ${icon} ${r.url}${chalk.dim(detail)}`);
      }
      console.log();
    }
  }

  // Keyword-match the bot reply to determine safe / unsafe / unknown
  _parseReply(reply) {
    const combined = [reply.text, ...reply.embeds]
      .join(' ')
      .toLowerCase();

    // Common "safe" indicators
    const safePatterns = [
      'safe', 'clean', 'no threats', 'not malicious',
      'legitimate', 'no issues', 'trusted', 'verified',
      'no risk', 'benign',
    ];

    // Common "unsafe" indicators
    const unsafePatterns = [
      'unsafe', 'malicious', 'phishing', 'scam', 'dangerous',
      'suspicious', 'threat', 'blocked', 'harmful', 'malware',
      'virus', 'compromised', 'flagged', 'warning', 'risk',
      'blacklisted', 'deceptive',
    ];

    const hasSafe = safePatterns.some((p) => combined.includes(p));
    const hasUnsafe = unsafePatterns.some((p) => combined.includes(p));

    if (hasUnsafe && !hasSafe) return 'unsafe';
    if (hasSafe && !hasUnsafe) return 'safe';
    if (hasUnsafe && hasSafe) return 'unsafe'; // err on the side of caution
    return 'unknown';
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}


