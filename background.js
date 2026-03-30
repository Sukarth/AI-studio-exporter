// AI Studio Exporter - Background Service Worker (with batch export support)

chrome.runtime.onInstalled.addListener(() => {
  console.log('AI Studio Exporter installed');
});

// Batch export state
let batchExportState = {
  isRunning: false,
  conversations: [],
  results: [],
  currentIndex: 0,
  tabId: null,
  shouldCancel: false,
};

// Handle messages from popup or content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'checkTab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        const isAIStudio = tabs[0].url && tabs[0].url.includes('aistudio.google.com');
        const isLibrary = tabs[0].url && tabs[0].url.includes('/library');
        const isPrompt = tabs[0].url && tabs[0].url.includes('/prompts/');
        sendResponse({ isAIStudio, isLibrary, isPrompt, url: tabs[0].url });
      } else {
        sendResponse({ isAIStudio: false });
      }
    });
    return true;
  }

  if (request.action === 'startBatchExport') {
    startBatchExport(request.conversations, request.tabId);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'cancelBatchExport') {
    batchExportState.shouldCancel = true;
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'getBatchStatus') {
    sendResponse({
      isRunning: batchExportState.isRunning,
      currentIndex: batchExportState.currentIndex,
      total: batchExportState.conversations.length,
      resultsCount: batchExportState.results.length,
    });
    return true;
  }
});

async function startBatchExport(conversations, tabId) {
  batchExportState = {
    isRunning: true,
    conversations: conversations,
    results: [],
    currentIndex: 0,
    tabId: tabId,
    shouldCancel: false,
  };

  console.log(`Starting batch export of ${conversations.length} conversations`);

  for (let i = 0; i < conversations.length; i++) {
    if (batchExportState.shouldCancel) {
      console.log('Batch export cancelled');
      break;
    }

    batchExportState.currentIndex = i;
    const conv = conversations[i];

    try {
      console.log(`[${i + 1}/${conversations.length}] Exporting: ${conv.name}`);

      // Navigate to the conversation
      await chrome.tabs.update(tabId, {
        url: `https://aistudio.google.com/prompts/${conv.id}`
      });

      // Wait for page to load
      await waitForTabLoad(tabId);
      await sleep(2500); // Extra wait for Angular to render

      // Inject extraction script
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['batch_export.js'],
      });

      const data = results[0]?.result;

      if (data && data.messages && data.messages.length > 0) {
        batchExportState.results.push({
          name: conv.name,
          id: conv.id,
          ...data,
        });
        console.log(`  ✅ ${conv.name}: ${data.messages.length} messages`);
      } else {
        batchExportState.results.push({
          name: conv.name,
          id: conv.id,
          messages: [],
          error: 'No messages found',
        });
        console.log(`  ⚠️ ${conv.name}: No messages`);
      }
    } catch (error) {
      console.error(`  ❌ ${conv.name}: ${error.message}`);
      batchExportState.results.push({
        name: conv.name,
        id: conv.id,
        messages: [],
        error: error.message,
      });
    }

    // Rate limiting
    if ((i + 1) % 10 === 0) {
      await sleep(2000);
    } else {
      await sleep(500);
    }
  }

  // Export completed - generate and download files
  console.log(`Batch export completed: ${batchExportState.results.length} conversations`);
  await generateAndDownload(tabId);

  batchExportState.isRunning = false;

  // Navigate back to library
  await chrome.tabs.update(tabId, {
    url: 'https://aistudio.google.com/library'
  });
}

async function generateAndDownload(tabId) {
  const results = batchExportState.results;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Generate JSON
  const jsonData = {
    exportDate: new Date().toISOString(),
    source: 'Google AI Studio',
    totalConversations: results.length,
    conversations: results,
  };

  const jsonBlob = JSON.stringify(jsonData, null, 2);

  // Generate Markdown
  let md = `# Google AI Studio 对话导出\n\n`;
  md += `- 导出时间: ${new Date().toLocaleString()}\n`;
  md += `- 对话总数: ${results.length}\n\n---\n\n`;

  for (const conv of results) {
    md += `# ${conv.name}\n\n`;
    if (conv.tokens) md += `Token: ${conv.tokens}\n\n`;
    if (conv.messages && conv.messages.length > 0) {
      for (const msg of conv.messages) {
        const label = msg.role === 'user' ? '👤 **User**' : '🤖 **Model**';
        md += `### ${label}\n\n${msg.content}\n\n`;
      }
    } else if (conv.error) {
      md += `> ⚠️ Error: ${conv.error}\n\n`;
    }
    md += `---\n\n`;
  }

  // Use chrome.scripting to inject download logic
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (jsonStr, mdStr, ts) => {
      function dl(content, filename, mime) {
        const blob = new Blob([content], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
      dl(jsonStr, `ai_studio_batch_export_${ts}.json`, 'application/json');
      setTimeout(() => dl(mdStr, `ai_studio_batch_export_${ts}.md`, 'text/markdown'), 500);
    },
    args: [jsonBlob, md, timestamp],
  });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout after 15 seconds
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('AI Studio Exporter background service worker loaded (with batch export)');
