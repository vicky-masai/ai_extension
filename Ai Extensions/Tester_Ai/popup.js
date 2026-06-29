/**
 * QA Smart Form Filler — Popup UI
 */
'use strict';

const autofillBtn = document.getElementById('autofill-btn');
const statusBanner = document.getElementById('status-banner');
const aiDot = document.getElementById('ai-dot');
const aiStatusText = document.getElementById('ai-status-text');
const apiKeyInput = document.getElementById('api-key-input');
const saveApiKeyBtn = document.getElementById('save-api-key-btn');

/**
 * @param {'success' | 'error' | 'warning'} type
 * @param {string} message
 */
function showStatus(type, message) {
  statusBanner.className = `visible ${type}`;
  statusBanner.textContent = message;
}

function clearStatus() {
  statusBanner.className = '';
  statusBanner.textContent = '';
}

/**
 * @param {boolean} loading
 */
function setLoading(loading) {
  autofillBtn.disabled = loading;
  autofillBtn.classList.toggle('loading', loading);
}

/**
 * @returns {Promise<chrome.tabs.Tab | undefined>}
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * @param {number} tabId
 * @returns {Promise<unknown>}
 */
function sendBackgroundMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * @param {{ status?: string, downloading?: boolean, message?: string }} capabilities
 */
function renderAICapabilities(capabilities) {
  aiDot.className = 'ai-dot';

  switch (capabilities?.status) {
    case 'readily':
      aiDot.classList.add('ready');
      aiStatusText.textContent = globalThis.QASmartAI?.GEMINI_MODEL
        ? `${globalThis.QASmartAI.GEMINI_MODEL} ready`
        : 'Gemini API ready';
      break;
    case 'after-download':
      aiDot.classList.add('downloading');
      aiStatusText.textContent = capabilities.downloading
        ? 'Model downloading…'
        : 'Model download required';
      break;
    case 'no':
    default:
      aiDot.classList.add('unavailable');
      aiStatusText.textContent = capabilities?.message || 'AI unavailable (fallback enabled)';
      break;
  }
}

async function refreshAICapabilities() {
  try {
    if (globalThis.QASmartAI) {
      const localCaps = await globalThis.QASmartAI.checkAICapabilities();
      renderAICapabilities(localCaps);
      return;
    }

    const tab = await getActiveTab();
    if (!tab?.id) {
      renderAICapabilities({ status: 'no', message: 'No active tab' });
      return;
    }

    const response = /** @type {{ ok: boolean, capabilities?: Record<string, unknown> }} */ (
      await sendBackgroundMessage({
        type: 'GET_AI_CAPABILITIES',
        tabId: tab.id,
      })
    );

    if (response?.ok && response.capabilities) {
      renderAICapabilities(response.capabilities);
    } else {
      renderAICapabilities({ status: 'no', message: 'Could not verify AI status' });
    }
  } catch {
    renderAICapabilities({ status: 'no', message: 'AI check failed (fallback enabled)' });
  }
}

async function handleAutofill() {
  clearStatus();
  setLoading(true);

  try {
    const tab = await getActiveTab();

    if (!tab?.id) {
      showStatus('error', 'No active tab found.');
      return;
    }

    if (
      tab.url?.startsWith('chrome://') ||
      tab.url?.startsWith('chrome-extension://') ||
      tab.url?.startsWith('edge://') ||
      tab.url?.startsWith('about:')
    ) {
      showStatus('error', 'Cannot fill forms on browser internal pages.');
      return;
    }

    const response = /** @type {{
      ok: boolean,
      filledCount?: number,
      totalFields?: number,
      source?: string,
      warning?: string,
      errorCode?: string,
      errorSeverity?: 'error' | 'warning',
      error?: string,
      code?: string
    }} */ (
      await sendBackgroundMessage({
        type: 'AUTOFILL_ACTIVE_TAB',
        tabId: tab.id,
      })
    );

    if (!response?.ok) {
      if (response?.code === 'NO_INPUTS') {
        showStatus('error', 'No inputs found on this page.');
      } else if (response?.error?.includes('Receiving end does not exist')) {
        showStatus('error', 'Could not reach the page. Refresh and try again.');
      } else {
        showStatus('error', response?.error || 'Auto-fill failed.');
      }
      return;
    }

    const sourceLabel = response.source === 'ai' ? 'AI-generated' : 'fallback';
    const successMsg = `Filled ${response.filledCount ?? 0} of ${response.totalFields ?? 0} fields (${sourceLabel}).`;

    if (response.warning) {
      const isCritical =
        response.errorSeverity === 'error' ||
        ['RATE_LIMIT', 'QUOTA_EXCEEDED', 'INVALID_API_KEY', 'NETWORK_ERROR', 'MODEL_UNAVAILABLE'].includes(
          response.errorCode || '',
        );
      showStatus(isCritical ? 'error' : 'warning', `${successMsg} ${response.warning}`);
    } else {
      showStatus('success', successMsg);
    }
  } catch (err) {
    showStatus('error', err?.message || 'Unexpected error during auto-fill.');
  } finally {
    setLoading(false);
  }
}

async function loadApiKey() {
  if (!globalThis.QASmartAI || !apiKeyInput) {
    return;
  }

  const key = await globalThis.QASmartAI.getApiKey();
  if (key) {
    apiKeyInput.value = key;
  }
}

async function handleSaveApiKey() {
  if (!globalThis.QASmartAI || !apiKeyInput) {
    return;
  }

  await globalThis.QASmartAI.setApiKey(apiKeyInput.value.trim());
  await refreshAICapabilities();
  showStatus('success', 'API key saved.');
}

autofillBtn.addEventListener('click', handleAutofill);
saveApiKeyBtn?.addEventListener('click', handleSaveApiKey);
document.addEventListener('DOMContentLoaded', async () => {
  await loadApiKey();
  await refreshAICapabilities();
});
