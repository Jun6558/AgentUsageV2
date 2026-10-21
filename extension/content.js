(() => {
  function collect() {
    if (location.pathname.replace(/\/$/, '') !== '/settings/usage') return null;
    return globalThis.AgentUsageParser.parseUsage(document.body.innerText);
  }
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === 'collect') reply(collect());
  });
  // Wait for asynchronously rendered metrics; only send changed normalized data.
  let lastPayload = '';
  let timer;
  function send() {
    const snapshot = collect();
    if (!snapshot || JSON.stringify(snapshot) === lastPayload) return;
    chrome.runtime.sendMessage({ type: 'usage', snapshot }).then(result => {
      if (result?.ok) lastPayload = JSON.stringify(snapshot);
    }).catch(() => {});
  }
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(send, 500); });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(send, 2000);
})();
