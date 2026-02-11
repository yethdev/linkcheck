import { chromium } from 'playwright';

export class DiscordAutomation {
  constructor(options = {}) {
    this.token = options.token;
    this.channelId = options.channelId;
    this.targetBotId = options.targetBotId;
    this.replyTimeout = options.replyTimeout ?? 15_000;
    this.headless = options.headless ?? true;

    this.browser = null;
    this.context = null;
    this.page = null;
    this._guildPath = null;
  }

  async launch() {
    this.browser = await chromium.launch({
      headless: this.headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    // Close default blank page that Chromium opens in non-headless mode
    for (const ctx of this.browser.contexts()) {
      for (const p of ctx.pages()) {
        await p.close();
      }
    }

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    this.page = await this.context.newPage();

    // Inject token before Discord's JS reads localStorage
    const token = this.token;
    await this.context.addInitScript((tok) => {
      window.localStorage.setItem('token', JSON.stringify(tok));
    }, token);

    // Auto-detect whether this is a DM or server channel via Discord API
    this._guildPath = await this._resolveGuild(this.channelId);

    // Navigate directly to the target channel
    const url = `https://discord.com/channels/${this._guildPath}/${this.channelId}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Discord's SPA takes a moment to fully hydrate after DOM is loaded
    await this.page.waitForLoadState('networkidle').catch(() => {});

    // Wait for the message input to appear (confirms we're authenticated)
    await this.page.waitForSelector(
      '[role="textbox"][data-slate-editor="true"]',
      { timeout: 20_000 }
    );
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async sendMessage(text) {
    const editor = this.page.locator(
      '[role="textbox"][data-slate-editor="true"]'
    );
    await editor.click();
    await editor.fill('');              // clear any draft

    if (text.startsWith('/')) {
      // Type the slash to enter slash-command mode
      await this.page.keyboard.type('/', { delay: 0 });
      // Brief wait for autocomplete popup, then dismiss it
      await this.page.waitForTimeout(80);
      const autocomplete = this.page.locator('[class*="autocomplete"], [id*="autocomplete"]');
      if (await autocomplete.isVisible().catch(() => false)) {
        await this.page.keyboard.press('Escape');
      }
      // Blast the rest of the command with ZERO per-char delay
      await this.page.keyboard.type(text.slice(1), { delay: 0 });
    } else {
      await this.page.keyboard.type(text, { delay: 0 });
    }

    await this.page.keyboard.press('Enter');

    // Quick verification that message was sent (textbox clears on success).
    // Reduced from 400ms to 100ms — Discord clears nearly instantly.
    await this.page.waitForTimeout(100);
    const remaining = await editor.textContent().catch(() => '');
    if (remaining.trim().length > 1) {
      console.warn('[Discord] Message may not have sent (textbox not cleared) — retrying Enter…');
      await editor.click();
      await this.page.waitForTimeout(100);
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(200);
      const still = await editor.textContent().catch(() => '');
      if (still.trim().length > 1) {
        throw new Error('Message failed to send — Discord may be disconnected');
      }
    }
  }

  // Polls for new messages from the target bot
  async waitForBotReply(timeout) {
    const waitMs = timeout ?? this.replyTimeout;

    // Snapshot the current message count so we can detect new ones
    const initialSnapshot = await this.page.evaluate(() => {
      // Try multiple selectors that Discord has used for message containers
      const selectors = [
        '[id^="chat-messages-"]',
        'li[id^="chat-messages"]',
        '[class*="message-"] [id^="message-content"]',
        'ol[data-list-id="chat-messages"] > li',
        '[class*="chatContent"] li[class*="messageListItem"]',
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return { selector: sel, count: els.length };
      }
      return { selector: null, count: 0 };
    });

    // Poll for new messages
    const startTime = Date.now();
    while (Date.now() - startTime < waitMs) {
      await this.page.waitForTimeout(150);          // ← 150ms poll (was 300ms)

      const result = await this.page.evaluate(
        ({ snapshot, botId }) => {
          // Gather all message elements using the detected selector, or fallback
          let msgs;
          if (snapshot.selector) {
            msgs = [...document.querySelectorAll(snapshot.selector)];
          } else {
            // Ultimate fallback: look for any list items in the chat area
            const ol = document.querySelector('ol[data-list-id="chat-messages"]')
              || document.querySelector('[class*="scrollerInner"]');
            msgs = ol ? [...ol.children] : [];
          }

          if (msgs.length <= snapshot.count) return null; // no new messages

          // Check new messages (from the end)
          for (let i = msgs.length - 1; i >= snapshot.count; i--) {
            const msg = msgs[i];
            const html = msg.innerHTML || '';

            // Check if this message is from the target bot
            // Method 1: data-author-id attribute
            const authorEl = msg.querySelector('[data-author-id]');
            const authorId = authorEl?.getAttribute('data-author-id');

            // Method 2: Check for bot tag
            const hasBotTag = msg.querySelector('[class*="botTag"]') !== null
              || html.includes('botTag');

            // Method 3: check if message contains the bot's avatar link with the bot ID
            const avatarMatch = html.includes(botId);

            const isFromBot = authorId === botId || avatarMatch || (hasBotTag && !authorId);

            if (isFromBot) {
              // Extract text content
              const contentEl = msg.querySelector('[id^="message-content-"]')
                || msg.querySelector('[class*="messageContent"]')
                || msg.querySelector('[class*="markup"]');
              const text = contentEl?.textContent?.trim() ?? '';

              // Extract embed text
              const embedEls = msg.querySelectorAll(
                '[class*="embedDescription"], [class*="embed-"] [class*="description"]'
              );
              const embeds = [...embedEls].map((el) => el.textContent.trim());

              // Also check for embed titles/fields as fallback
              const embedWrappers = msg.querySelectorAll('[class*="embed"]');
              if (embeds.length === 0 && embedWrappers.length > 0) {
                for (const ew of embedWrappers) {
                  const t = ew.textContent?.trim();
                  if (t) embeds.push(t);
                }
              }

              return { text, embeds };
            }
          }
          return null; // new messages, but none from bot
        },
        { snapshot: initialSnapshot, botId: this.targetBotId }
      );

      if (result) {
        // The bot may edit its message (e.g. "Sending command..." → actual results).
        // Wait for the message content to stabilize before returning.
        let stableText = result.text;
        let stableEmbeds = result.embeds;
        let unchangedCount = 0;

        while (unchangedCount < 2 && Date.now() - startTime < waitMs) {
          await this.page.waitForTimeout(300);      // ← 300ms stability (was 700ms)

          // Re-read the latest bot message
          const updated = await this.page.evaluate(
            ({ snapshot, botId }) => {
              let msgs;
              if (snapshot.selector) {
                msgs = [...document.querySelectorAll(snapshot.selector)];
              } else {
                const ol = document.querySelector('ol[data-list-id="chat-messages"]')
                  || document.querySelector('[class*="scrollerInner"]');
                msgs = ol ? [...ol.children] : [];
              }

              // Find the last bot message
              for (let i = msgs.length - 1; i >= 0; i--) {
                const msg = msgs[i];
                const html = msg.innerHTML || '';
                const authorEl = msg.querySelector('[data-author-id]');
                const authorId = authorEl?.getAttribute('data-author-id');
                const hasBotTag = msg.querySelector('[class*="botTag"]') !== null || html.includes('botTag');
                const avatarMatch = html.includes(botId);

                if (authorId === botId || avatarMatch || (hasBotTag && !authorId)) {
                  const contentEl = msg.querySelector('[id^="message-content-"]')
                    || msg.querySelector('[class*="messageContent"]')
                    || msg.querySelector('[class*="markup"]');
                  const text = contentEl?.textContent?.trim() ?? '';

                  const embedEls = msg.querySelectorAll(
                    '[class*="embedDescription"], [class*="embed-"] [class*="description"]'
                  );
                  const embeds = [...embedEls].map((el) => el.textContent.trim());
                  const embedWrappers = msg.querySelectorAll('[class*="embed"]');
                  if (embeds.length === 0 && embedWrappers.length > 0) {
                    for (const ew of embedWrappers) {
                      const t = ew.textContent?.trim();
                      if (t) embeds.push(t);
                    }
                  }

                  return { text, embeds };
                }
              }
              return null;
            },
            { snapshot: initialSnapshot, botId: this.targetBotId }
          );

          if (updated && updated.text === stableText && JSON.stringify(updated.embeds) === JSON.stringify(stableEmbeds)) {
            unchangedCount++;
          } else if (updated) {
            stableText = updated.text;
            stableEmbeds = updated.embeds;
            unchangedCount = 0;
          }
        }

        return { text: stableText, embeds: stableEmbeds };
      }
    }

    throw new Error('Timed out waiting for bot reply');
  }

  async sendAndAwaitReply(text) {
    // Start listening BEFORE sending so we don't miss fast replies
    const replyPromise = this.waitForBotReply();
    // Small delay so the observer is wired up
    await this.page.waitForTimeout(100);
    await this.sendMessage(text);
    return replyPromise;
  }

  // Send a message and stream the reply as the bot progressively edits it.
  // onUpdate receives { text, embeds } on each change; return false to signal
  // the content is still incomplete (prevents early stability exit).
  async sendAndStreamReply(text, onUpdate, timeout) {
    const waitMs = timeout ?? this.replyTimeout;

    // Snapshot current message count
    const snapshot = await this.page.evaluate(() => {
      const selectors = [
        '[id^="chat-messages-"]',
        'li[id^="chat-messages"]',
        'ol[data-list-id="chat-messages"] > li',
        '[class*="chatContent"] li[class*="messageListItem"]',
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return { selector: sel, count: els.length };
      }
      return { selector: null, count: 0 };
    });

    // Send the message
    await this.sendMessage(text);

    // Helper to read the latest bot message
    const readBot = () => this.page.evaluate(
      ({ snapshot, botId }) => {
        let msgs;
        if (snapshot.selector) {
          msgs = [...document.querySelectorAll(snapshot.selector)];
        } else {
          const ol = document.querySelector('ol[data-list-id="chat-messages"]')
            || document.querySelector('[class*="scrollerInner"]');
          msgs = ol ? [...ol.children] : [];
        }
        for (let i = msgs.length - 1; i >= Math.max(0, snapshot.count - 1); i--) {
          const msg = msgs[i];
          const html = msg.innerHTML || '';
          const authorEl = msg.querySelector('[data-author-id]');
          const authorId = authorEl?.getAttribute('data-author-id');
          const hasBotTag = msg.querySelector('[class*="botTag"]') !== null || html.includes('botTag');
          const avatarMatch = html.includes(botId);
          if (authorId === botId || avatarMatch || (hasBotTag && !authorId)) {
            const contentEl = msg.querySelector('[id^="message-content-"]')
              || msg.querySelector('[class*="messageContent"]')
              || msg.querySelector('[class*="markup"]');
            const text = contentEl?.textContent?.trim() ?? '';
            const embedEls = msg.querySelectorAll(
              '[class*="embedDescription"], [class*="embed-"] [class*="description"]'
            );
            const embeds = [...embedEls].map(el => el.textContent.trim());
            const embedWrappers = msg.querySelectorAll('[class*="embed"]');
            if (embeds.length === 0 && embedWrappers.length > 0) {
              for (const ew of embedWrappers) {
                const t = ew.textContent?.trim();
                if (t) embeds.push(t);
              }
            }
            return { text, embeds };
          }
        }
        return null;
      },
      { snapshot, botId: this.targetBotId }
    );

    const startTime = Date.now();
    let lastText = '';
    let unchangedCount = 0;
    let foundBot = false;
    let contentComplete = true;  // assume complete unless callback says otherwise

    while (Date.now() - startTime < waitMs) {
      await this.page.waitForTimeout(150);          // ← 150ms poll (was 400ms)
      if (onUpdate._aborted) break;
      const current = await readBot();
      if (!current) continue;

      foundBot = true;
      const currentFull = current.text + '\n' + current.embeds.join('\n');

      if (currentFull !== lastText) {
        lastText = currentFull;
        unchangedCount = 0;
        try {
          const result = onUpdate(current);
          contentComplete = result !== false;
        } catch {
          contentComplete = true;
        }
      } else {
        unchangedCount++;
      }

      // Stability: only exit early when the callback has confirmed content
      // is truly complete (note seen, enough platforms, no loading indicators).
      // When content is INCOMPLETE, never exit on stability — rely on the
      // hard timeout instead.  The bot can pause 1-3s between edits.
      if (contentComplete && unchangedCount >= 5) {
        return current;
      }
    }

    if (!foundBot) throw new Error('Timed out waiting for bot reply');
    // Return whatever we have
    const final = await readBot();
    return final || { text: lastText, embeds: [] };
  }

  async screenshot(filePath) {
    await this.page.screenshot({ path: filePath, fullPage: false });
  }

  async switchChannel(channelId) {
    this.channelId = channelId;
    this._guildPath = await this._resolveGuild(channelId);
    await this.page.goto(
      `https://discord.com/channels/${this._guildPath}/${channelId}`,
      { waitUntil: 'networkidle', timeout: 20_000 }
    );
    await this.page.waitForSelector(
      '[role="textbox"][data-slate-editor="true"]',
      { timeout: 15_000 }
    );
  }

  // Resolves whether a channel lives in a server or is a DM
  async _resolveGuild(channelId) {
    try {
      const channelInfo = await fetch(`https://discord.com/api/v9/channels/${channelId}`, {
        headers: { Authorization: this.token },
      });
      if (!channelInfo.ok) {
        console.warn(`[Discord] Could not resolve channel ${channelId} (HTTP ${channelInfo.status}), assuming DM`);
        return '@me';
      }
      const channelData = await channelInfo.json();
      return channelData.guild_id || '@me';
    } catch (err) {
      console.warn(`[Discord] API call failed for channel ${channelId}:`, err.message, '— assuming DM');
      return '@me';
    }
  }
}
