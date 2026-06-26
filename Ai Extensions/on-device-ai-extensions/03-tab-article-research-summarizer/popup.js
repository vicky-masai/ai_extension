document.addEventListener('DOMContentLoaded', async () => {
  const summarizeBtn = document.getElementById('summarize-btn');
  const compareBtn = document.getElementById('compare-btn');
  const output = document.getElementById('output');
  const status = document.getElementById('status');
  const usageEl = document.getElementById('usage');
  const proKeyInput = document.getElementById('pro-key');

  async function refreshUsage() {
    const s = await chrome.runtime.sendMessage({ type: 'TARS_GET_STATUS' });
    usageEl.textContent = s.pro
      ? 'Pro · Unlimited summaries'
      : `${s.remaining} of ${s.dailyLimit} summaries left today`;
    return s;
  }

  function setLoading(isLoading, msg) {
    summarizeBtn.disabled = isLoading;
    compareBtn.disabled = isLoading;
    status.textContent = msg || '';
  }

  const stored = await chrome.storage.local.get('tars_pro_key');
  if (stored.tars_pro_key) proKeyInput.value = stored.tars_pro_key;

  proKeyInput.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ type: 'TARS_SET_PRO_KEY', key: proKeyInput.value.trim() });
    await refreshUsage();
  });

  await refreshUsage();

  summarizeBtn.addEventListener('click', async () => {
    setLoading(true, 'Extracting page content…');
    output.textContent = 'Processing on-device…';

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab.');

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script, style, nav, footer, aside').forEach((el) => el.remove());
          return {
            title: document.title,
            text: (clone.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 15000),
          };
        },
      });

      if (!result?.text || result.text.length < 50) {
        throw new Error('Not enough readable content on this page.');
      }

      setLoading(true, 'Summarizing with on-device AI…');

      const response = await chrome.runtime.sendMessage({
        type: 'TARS_SUMMARIZE_TAB',
        text: result.text,
        title: result.title,
      });

      if (!response.success) {
        output.textContent = response.error;
        status.textContent = response.upgrade ? 'Upgrade to Pro for unlimited summaries.' : '';
      } else {
        output.textContent = response.summary;
        status.textContent = `Done · ${response.remaining === Infinity ? 'unlimited' : response.remaining + ' left today'}`;
      }
      await refreshUsage();
    } catch (err) {
      output.textContent = err.message || 'Failed to summarize.';
    } finally {
      setLoading(false, '');
    }
  });

  compareBtn.addEventListener('click', async () => {
    setLoading(true, 'Reading top 5 tabs and comparing…');
    output.textContent = 'Running comparative analysis on-device…';

    const response = await chrome.runtime.sendMessage({ type: 'TARS_COMPARE_TABS' });

    if (!response.success) {
      output.textContent = response.error;
    } else {
      output.textContent = response.summary;
      status.textContent = `Compared ${response.tabCount} tabs · ${response.remaining === Infinity ? 'unlimited' : response.remaining + ' left'}`;
    }
    await refreshUsage();
    setLoading(false, '');
  });
});
