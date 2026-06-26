(function () {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'TARS_EXTRACT_PAGE') {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('script, style, nav, footer, aside, noscript').forEach((el) => el.remove());
      sendResponse({
        title: document.title,
        text: (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim(),
        url: location.href,
      });
    }
    return false;
  });
})();
