(function () {
  const TOAST_ID = 'pfwa-toast';
  const SUPPORTED =
    /mail\.google\.com|linkedin\.com|notion\.so|atlassian\.net/.test(
      window.location.hostname
    );

  if (!SUPPORTED) return;

  function showToast(message, variant = 'info') {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      toast.style.cssText = `
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
        max-width: 360px; padding: 14px 18px; border-radius: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px; line-height: 1.5; box-shadow: 0 8px 32px rgba(0,0,0,0.18);
        transition: opacity 0.3s, transform 0.3s;
      `;
      document.body.appendChild(toast);
    }

    const colors = {
      info: { bg: '#4F46E5', fg: '#fff' },
      success: { bg: '#059669', fg: '#fff' },
      error: { bg: '#DC2626', fg: '#fff' },
      loading: { bg: '#1E293B', fg: '#fff' },
    };
    const c = colors[variant] || colors.info;
    toast.style.background = c.bg;
    toast.style.color = c.fg;
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    if (variant !== 'loading') {
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
      }, 4000);
    }
  }

  function getActiveEditable() {
    const el = document.activeElement;
    if (!el) return null;
    if (el.isContentEditable) return el;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    let node = selection.anchorNode;
    while (node && node !== document.body) {
      if (node.nodeType === Node.ELEMENT_NODE && node.isContentEditable) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  function replaceSelection(newText) {
    const editable = getActiveEditable();
    if (editable) {
      if (editable.isContentEditable) {
        document.execCommand('insertText', false, newText);
        return true;
      }
      if (editable.selectionStart !== undefined) {
        const start = editable.selectionStart;
        const end = editable.selectionEnd;
        const val = editable.value;
        editable.value = val.slice(0, start) + newText + val.slice(end);
        editable.selectionStart = editable.selectionEnd = start + newText.length;
        editable.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
    }

    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(newText));
      return true;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PFWA_LOADING') {
      showToast(`Applying ${msg.action} fix on-device…`, 'loading');
    }
    if (msg.type === 'PFWA_RESULT') {
      const ok = replaceSelection(msg.text);
      const suffix =
        msg.remaining === Infinity
          ? ''
          : ` · ${msg.remaining} fixes left today`;
      showToast(
        ok ? `Text updated on-device.${suffix}` : 'Copied result — paste manually.',
        'success'
      );
      if (!ok) {
        navigator.clipboard?.writeText(msg.text);
      }
    }
    if (msg.type === 'PFWA_ERROR') {
      showToast(msg.error, 'error');
      if (msg.upgrade) {
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'PFWA_GET_STATUS' });
        }, 500);
      }
    }
  });
})();
