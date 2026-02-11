#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'readline';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import dotenv from 'dotenv';
import { LinkChecker } from './link-checker.js';
import { startWebServer as startLegacyWebServer } from './web-server.js';
import { startWebServer as startNativeWebServer } from './web-server-native.js';
import { startDiscordBot } from './discord-bot.js';

dotenv.config();

function loadConfig(opts) {
  const token = opts.token || process.env.DISCORD_TOKEN;
  const channelId = opts.channel || process.env.CHANNEL_ID;
  const targetBotId = opts.bot || process.env.TARGET_BOT_ID;
  const replyTimeout = Number(opts.timeout || process.env.REPLY_TIMEOUT || 15000);
  const headless = opts.visible ? false : (process.env.HEADLESS !== 'false');

  if (!token || token === 'your_token_here') {
    console.error(chalk.red('Error: DISCORD_TOKEN is required.'));
    console.error('Set it in .env or pass --token <value>');
    process.exit(1);
  }
  if (!channelId || channelId === '1234567890') {
    console.error(chalk.red('Error: CHANNEL_ID is required.'));
    console.error('Set it in .env or pass --channel <value>');
    process.exit(1);
  }
  if (!targetBotId || targetBotId === '1234567890') {
    console.error(chalk.red('Error: TARGET_BOT_ID is required.'));
    console.error('Set it in .env or pass --bot <value>');
    process.exit(1);
  }

  return { token, channelId, targetBotId, replyTimeout, headless };
}

program
  .name('link-checker')
  .description(
    'Multi-platform URL categorization checker'
  )
  .version('1.0.0');

const sharedOpts = (cmd) =>
  cmd
    .option('-t, --token <token>', 'Discord user token')
    .option('-c, --channel <id>', 'Channel ID')
    .option('-b, --bot <id>', 'Target bot user ID')
    .option('--timeout <ms>', 'Reply timeout in ms', '15000')
    .option('--visible', 'Run with visible browser (not headless)')
    .option('-p, --prefix <text>', 'Command prefix for the bot (e.g. "!check ")', '');

sharedOpts(
  program
    .command('check <urls...>')
    .description('Check one or more URLs')
)
  .option('-d, --delay <ms>', 'Delay between checks in ms', '2000')
  .action(async (urls, opts) => {
    const config = loadConfig(opts);
    const checker = new LinkChecker(config);

    try {
      await checker.init();
      await checker.checkLinks(urls, opts.prefix, Number(opts.delay));
      checker.printSummary();
    } catch (err) {
      console.error(chalk.red(`\nFatal: ${err.message}`));
      await screenshotOnError(checker);
      process.exit(1);
    } finally {
      await checker.destroy();
    }
  });

sharedOpts(
  program
    .command('file <path>')
    .description('Check URLs from a file (one URL per line)')
)
  .option('-d, --delay <ms>', 'Delay between checks in ms', '2000')
  .action(async (path, opts) => {
    if (!existsSync(path)) {
      console.error(chalk.red(`File not found: ${path}`));
      process.exit(1);
    }

    const urls = readFileSync(path, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    if (urls.length === 0) {
      console.error(chalk.yellow('No URLs found in the file.'));
      process.exit(0);
    }

    console.log(chalk.dim(`Found ${urls.length} URL(s) to check.\n`));
    const config = loadConfig(opts);
    const checker = new LinkChecker(config);

    try {
      await checker.init();
      await checker.checkLinks(urls, opts.prefix, Number(opts.delay));
      checker.printSummary();
    } catch (err) {
      console.error(chalk.red(`\nFatal: ${err.message}`));
      await screenshotOnError(checker);
      process.exit(1);
    } finally {
      await checker.destroy();
    }
  });

sharedOpts(
  program
    .command('interactive')
    .alias('i')
    .description('Interactive mode — type messages and see bot replies live')
)
  .action(async (opts) => {
    const config = loadConfig(opts);
    const checker = new LinkChecker(config);

    try {
      await checker.init();

      console.log(
        chalk.green('\n✔ Interactive mode. Type a URL or message, press Enter.')
      );
      console.log(chalk.dim('  Commands:  .quit  .screenshot  .summary\n'));

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.blue('> '),
      });

      rl.prompt();

      rl.on('line', async (line) => {
        const input = line.trim();

        if (!input) {
          rl.prompt();
          return;
        }

        if (input === '.quit' || input === '.exit') {
          checker.printSummary();
          rl.close();
          return;
        }

        if (input === '.screenshot') {
          if (!existsSync('screenshots')) mkdirSync('screenshots');
          const p = `screenshots/debug-${Date.now()}.png`;
          await checker.screenshot(p);
          console.log(chalk.dim(`Saved screenshot to ${p}`));
          rl.prompt();
          return;
        }

        if (input === '.summary') {
          checker.printSummary();
          rl.prompt();
          return;
        }

        // If input looks like a URL, run through the link checker
        if (/^https?:\/\//.test(input)) {
          const msg = opts.prefix ? `${opts.prefix}${input}` : input;
          await checker.checkLink(input, opts.prefix);
        } else {
          // Otherwise just send raw and print the reply
          try {
            const reply = await checker.sendRaw(input);
            console.log(chalk.green('Bot:'), reply.text || chalk.dim('(no text)'));
            if (reply.embeds.length > 0) {
              for (const e of reply.embeds) {
                console.log(chalk.green('  Embed:'), e);
              }
            }
          } catch (err) {
            console.error(chalk.red(`Error: ${err.message}`));
          }
        }

        rl.prompt();
      });

      rl.on('close', async () => {
        await checker.destroy();
        process.exit(0);
      });
    } catch (err) {
      console.error(chalk.red(`\nFatal: ${err.message}`));
      await screenshotOnError(checker);
      await checker.destroy();
      process.exit(1);
    }
  });

program
  .command('bot')
  .description('Start the Discord slash-command bot')
  .action(async () => {
    await startDiscordBot();
  });

program
  .command('web')
  .alias('w')
  .description('Launch the web UI for URL categorization checking')
  .option('--port <number>', 'HTTP port', '3000')
  .action(async (opts) => {
    await startNativeWebServer(Number(opts.port));
  });

sharedOpts(
  program
    .command('web-legacy')
    .description('Launch the legacy web UI (requires Discord bot)')
)
  .option('--port <number>', 'HTTP port', '3000')
  .action(async (opts) => {
    const config = loadConfig(opts);
    await startLegacyWebServer(config, Number(opts.port));
  });

async function screenshotOnError(checker) {
  try {
    if (!existsSync('screenshots')) mkdirSync('screenshots');
    await checker.screenshot(`screenshots/error-${Date.now()}.png`);
    console.log(chalk.dim('Debug screenshot saved to screenshots/'));
  } catch { /* ignore */ }
}


process.on('unhandledRejection', (err) => {
  console.error('[Process] Unhandled rejection (ignored):', err?.message ?? err);
});

program.parse();
