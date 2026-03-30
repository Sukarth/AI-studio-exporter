/**
 * Batch export script for AI Studio Exporter
 * Injected by background.js to extract conversation data from each prompt page
 */

(async function() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Wait for Angular to render chat turns
  async function waitForContent(maxRetries = 8) {
    for (let i = 0; i < maxRetries; i++) {
      const turns = document.querySelectorAll('ms-chat-turn');
      if (turns.length > 0) return turns;
      await sleep(1000);
    }
    return [];
  }

  // Extract conversation data from the current page
  async function extractConversation() {
    const chatTurns = await waitForContent();
    const messages = [];

    for (const turn of chatTurns) {
      // Scroll into view to ensure lazy content loads
      turn.scrollIntoView();
      await sleep(300);

      const roleEl = turn.querySelector('[data-turn-role]');
      const role = roleEl ? roleEl.getAttribute('data-turn-role') : 'unknown';

      // Extract text
      const textChunk = turn.querySelector('ms-text-chunk');
      const text = textChunk ? textChunk.innerText.trim() : '';

      if (text) {
        messages.push({ role: role.toLowerCase(), content: text });
      }

      // Extract image
      const img = turn.querySelector('img.loaded-image');
      if (img) {
        messages.push({ role: role.toLowerCase(), content: '[Image attachment]', type: 'image' });
      }

      // Extract file attachment
      const fileChunk = turn.querySelector('ms-file-chunk');
      if (fileChunk) {
        const fileName = fileChunk.querySelector('span')?.innerText || 'attachment';
        messages.push({ role: role.toLowerCase(), content: `[File: ${fileName}]`, type: 'attachment' });
      }
    }

    // Get title and token count
    const titleEl = document.querySelector('.actions.pointer.mode-title');
    const tokenEl = document.querySelector('.token-container');

    return {
      title: titleEl ? titleEl.innerText.trim() : document.title.replace(' | Google AI Studio', ''),
      tokens: tokenEl ? tokenEl.innerText.trim() : '',
      messageCount: messages.length,
      messages: messages
    };
  }

  // Return the extracted data
  const data = await extractConversation();
  return data;
})();
