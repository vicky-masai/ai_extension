/**
 * QA Smart Form Filler — Background Service Worker
 * Orchestrates scrape → AI generation → injection across tabs.
 *
 * Note: LanguageModel is unavailable in service workers. AI calls are delegated
 * to the content script (extension page context) via message passing.
 */
'use strict';

const MESSAGE_TIMEOUT_MS = 60000;

/**
 * @param {number} tabId
 * @param {Record<string, unknown>} message
 * @returns {Promise<unknown>}
 */
async function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Content script did not respond in time. Try refreshing the page.'));
    }, MESSAGE_TIMEOUT_MS);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timeoutId);

      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

/**
 * @param {number} tabId
 */
async function ensureContentScript(tabId) {
  try {
    await sendTabMessage(tabId, { type: 'SCRAPE_FORM_FIELDS' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/ai-engine.js', 'content.js'],
    });
  }
}

/**
 * @param {Record<string, unknown>[]} fields
 * @returns {Record<string, unknown>}
 */
function generateFallbackData(fields) {
  const fallbackValues = {};

  let emailCounter = 1;

  for (const field of fields) {
    const key = field.key;
    const type = String(field.type || 'text').toLowerCase();
    const label = String(field.label || field.name || '').toLowerCase();

    if (type === 'hidden' || field.disabled) {
      continue;
    }

    if (type === 'email' || label.includes('email')) {
      fallbackValues[key] = `qa.tester${emailCounter}@example.com`;
      emailCounter += 1;
    } else if (type === 'tel' || label.includes('phone')) {
      fallbackValues[key] = '+1-555-0100';
    } else if (type === 'number') {
      fallbackValues[key] = 42;
    } else if (type === 'checkbox') {
      fallbackValues[key] = true;
    } else if (field.tag === 'select' && Array.isArray(field.options) && field.options[0]) {
      fallbackValues[key] = field.options[0].value;
    } else {
      fallbackValues[key] = `Test value ${String(key).replace('field_', '')}`;
    }
  }

  return fallbackValues;
}

/**
 * @param {number} tabId
 * @param {Record<string, unknown>[]} fields
 */
async function generateTestData(tabId, fields) {
  try {
    const response = /** @type {{ ok: boolean, data?: Record<string, unknown>, source?: string, warning?: string, errorCode?: string, errorSeverity?: string, error?: string }} */ (
      await sendTabMessage(tabId, {
        type: 'GENERATE_TEST_DATA',
        fields,
      })
    );

    if (response?.ok && response.data) {
      return {
        data: response.data,
        source: response.source || 'ai',
        warning: response.warning,
        errorCode: response.errorCode,
        errorSeverity: response.errorSeverity,
      };
    }

    throw new Error(response?.error || 'AI generation failed.');
  } catch (err) {
    return {
      data: generateFallbackData(fields),
      source: 'fallback',
      warning: `Circuit breaker engaged: ${err?.message || 'Using generic fallback data.'}`,
    };
  }
}

/**
 * @param {number} tabId
 */
async function runAutofillPipeline(tabId) {
  await ensureContentScript(tabId);

  const scrapeResponse = /** @type {{ ok: boolean, fields?: Record<string, unknown>[], count?: number, error?: string }} */ (
    await sendTabMessage(tabId, { type: 'SCRAPE_FORM_FIELDS' })
  );

  if (!scrapeResponse?.ok) {
    throw new Error(scrapeResponse?.error || 'Failed to scrape form fields.');
  }

  const fields = scrapeResponse.fields || [];

  if (fields.length === 0) {
    const error = new Error('No visible form inputs found on this page.');
    error.code = 'NO_INPUTS';
    throw error;
  }

  const generation = await generateTestData(tabId, fields);

  const injectResponse = /** @type {{ ok: boolean, filledCount?: number, totalFields?: number, error?: string }} */ (
    await sendTabMessage(tabId, {
      type: 'INJECT_TEST_DATA',
      data: generation.data,
    })
  );

  if (!injectResponse?.ok) {
    throw new Error(injectResponse?.error || 'Failed to inject test data.');
  }

  return {
    filledCount: injectResponse.filledCount ?? 0,
    totalFields: injectResponse.totalFields ?? fields.length,
    source: generation.source,
    warning: generation.warning,
    errorCode: generation.errorCode,
    errorSeverity: generation.errorSeverity,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handleMessage = async () => {
    try {
      switch (message?.type) {
        case 'GET_AI_CAPABILITIES': {
          const tabId = message.tabId;
          if (!tabId) {
            return { ok: false, error: 'No active tab.' };
          }

          await ensureContentScript(tabId);
          const response = await sendTabMessage(tabId, { type: 'CHECK_AI_CAPABILITIES' });
          return response;
        }

        case 'AUTOFILL_ACTIVE_TAB': {
          const tabId = message.tabId;
          if (!tabId) {
            return { ok: false, error: 'No active tab to fill.' };
          }

          const result = await runAutofillPipeline(tabId);
          return { ok: true, ...result };
        }

        case 'PROCESS_FORM_CONTEXT': {
          const tabId = message.tabId;
          const fields = message.fields || [];

          if (!tabId) {
            return { ok: false, error: 'Missing tabId for form context processing.' };
          }

          if (fields.length === 0) {
            return { ok: false, error: 'No form context metadata received.', code: 'NO_INPUTS' };
          }

          const generation = await generateTestData(tabId, fields);
          return { ok: true, ...generation };
        }

        default:
          return { ok: false, error: `Unknown background message: ${message?.type}` };
      }
    } catch (err) {
      return {
        ok: false,
        error: err?.message || 'Background service worker error.',
        code: err?.code,
      };
    }
  };

  handleMessage().then(sendResponse);
  return true;
});
