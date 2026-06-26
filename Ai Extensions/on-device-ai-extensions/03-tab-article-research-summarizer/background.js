const DAILY_LIMIT = 3;
const STORAGE_KEYS = { usage: 'tars_usage', proKey: 'tars_pro_key' };

function getSummarizer() {
  return globalThis.Summarizer || (typeof chrome !== 'undefined' && chrome.aiOriginTrial?.summarizer);
}

function getLanguageModel() {
  return globalThis.LanguageModel || self.LanguageModel;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getUsage() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.usage);
  const usage = data[STORAGE_KEYS.usage] || { date: todayKey(), count: 0 };
  if (usage.date !== todayKey()) return { date: todayKey(), count: 0 };
  return usage;
}

async function isPro() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.proKey);
  return typeof data[STORAGE_KEYS.proKey] === 'string' && data[STORAGE_KEYS.proKey].trim().length >= 8;
}

async function checkRateLimit() {
  if (await isPro()) return { allowed: true, remaining: Infinity };
  const usage = await getUsage();
  const remaining = Math.max(0, DAILY_LIMIT - usage.count);
  return { allowed: remaining > 0, remaining, limit: DAILY_LIMIT };
}

async function incrementUsage() {
  if (await isPro()) return;
  const usage = await getUsage();
  usage.count += 1;
  await chrome.storage.local.set({ [STORAGE_KEYS.usage]: usage });
}

async function createSummarizer(type = 'key-points') {
  const Summarizer = getSummarizer();
  if (!Summarizer) {
    throw new Error('Summarizer API unavailable. Requires Chrome 138+.');
  }

  const options = { type, format: 'markdown', length: 'medium' };
  const availability = await Summarizer.availability(options);

  if (availability === 'unavailable') {
    throw new Error('On-device summarizer unavailable on this device.');
  }

  return Summarizer.create({
    ...options,
    monitor(m) {
      m.addEventListener('downloadprogress', () => {});
    },
  });
}

async function summarizeText(text, title) {
  const Summarizer = getSummarizer();

  if (Summarizer) {
    try {
      const summarizer = await createSummarizer('key-points');
      const summary = await summarizer.summarize(text);
      summarizer.destroy?.();
      return formatStructuredMarkdown(summary, title);
    } catch (err) {
      if (getLanguageModel()) {
        return summarizeViaPrompt(text, title);
      }
      throw err;
    }
  }

  return summarizeViaPrompt(text, title);
}

function formatStructuredMarkdown(raw, title) {
  return `# ${title || 'Article Summary'}

## Key Points
${raw}

## Action Items
- Review findings and validate against source
- Share summary with stakeholders

## Pros / Cons
### Pros
- Concise on-device analysis with no data leakage

### Cons
- Verify critical claims against the original article`;
}

async function summarizeViaPrompt(text, title) {
  const LanguageModel = getLanguageModel();
  if (!LanguageModel) throw new Error('No AI APIs available.');

  const availability = await LanguageModel.availability({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  });

  if (availability === 'unavailable') {
    throw new Error('On-device AI unavailable.');
  }

  const session = await LanguageModel.create({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
    monitor(m) {
      m.addEventListener('downloadprogress', () => {});
    },
  });

  const truncated = text.slice(0, 12000);
  const result = await session.prompt(
    `Summarize the following article as structured Markdown with sections: Key Points, Action Items, Pros, Cons.\n\nTitle: ${title}\n\n${truncated}`
  );
  session.destroy?.();
  return result;
}

async function comparativeAnalysis(articles) {
  const LanguageModel = getLanguageModel();
  if (!LanguageModel) {
    throw new Error('Prompt API required for comparative analysis.');
  }

  const availability = await LanguageModel.availability({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  });

  if (availability === 'unavailable') {
    throw new Error('On-device AI unavailable for comparison.');
  }

  const session = await LanguageModel.create({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
    monitor(m) {
      m.addEventListener('downloadprogress', () => {});
    },
  });

  const corpus = articles
    .map((a, i) => `### Source ${i + 1}: ${a.title}\n${a.text.slice(0, 4000)}`)
    .join('\n\n');

  const result = await session.prompt(
    `You are a research analyst. Compare these ${articles.length} articles and produce Markdown with:
## Comparative Overview
## Common Themes
## Key Differences
## Recommended Actions
## Per-Article Verdict (table format)

Articles:
${corpus}`
  );
  session.destroy?.();
  return result;
}

async function extractTabText(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('script, style, nav, footer, aside, noscript').forEach((el) => el.remove());
      return {
        title: document.title,
        text: (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 15000),
        url: location.href,
      };
    },
  });
  return results[0]?.result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TARS_GET_STATUS') {
    Promise.all([checkRateLimit(), isPro()]).then(([limit, pro]) => {
      sendResponse({ ...limit, pro, dailyLimit: DAILY_LIMIT });
    });
    return true;
  }

  if (msg.type === 'TARS_SET_PRO_KEY') {
    chrome.storage.local.set({ [STORAGE_KEYS.proKey]: msg.key || '' }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'TARS_SUMMARIZE_TAB') {
    (async () => {
      try {
        const limit = await checkRateLimit();
        if (!limit.allowed) {
          sendResponse({
            success: false,
            error: `Daily limit reached (${DAILY_LIMIT} summaries). Upgrade to Pro.`,
            upgrade: true,
          });
          return;
        }

        const summary = await summarizeText(msg.text, msg.title);
        await incrementUsage();
        const updated = await checkRateLimit();
        sendResponse({ success: true, summary, remaining: updated.remaining });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message?.includes('download')
            ? 'Model downloading. Try again shortly.'
            : err.message || 'Summarization failed.',
        });
      }
    })();
    return true;
  }

  if (msg.type === 'TARS_COMPARE_TABS') {
    (async () => {
      try {
        const limit = await checkRateLimit();
        if (!limit.allowed) {
          sendResponse({
            success: false,
            error: `Daily limit reached (${DAILY_LIMIT}). Upgrade to Pro.`,
            upgrade: true,
          });
          return;
        }

        const tabs = await chrome.tabs.query({ currentWindow: true });
        const topTabs = tabs.filter((t) => t.id && t.url?.startsWith('http')).slice(0, 5);

        const articles = [];
        for (const tab of topTabs) {
          try {
            const data = await extractTabText(tab.id);
            if (data?.text?.length > 100) articles.push(data);
          } catch {
            /* skip restricted tabs */
          }
        }

        if (articles.length < 2) {
          sendResponse({
            success: false,
            error: 'Need at least 2 readable tabs in the current window.',
          });
          return;
        }

        const analysis = await comparativeAnalysis(articles);
        await incrementUsage();
        const updated = await checkRateLimit();
        sendResponse({ success: true, summary: analysis, tabCount: articles.length, remaining: updated.remaining });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message || 'Comparative analysis failed.',
        });
      }
    })();
    return true;
  }

  return false;
});
