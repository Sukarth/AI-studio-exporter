// AI Studio Exporter - Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const exportBtn = document.getElementById('exportBtn');
  const statusDiv = document.getElementById('status');
  const statusText = document.getElementById('statusText');
  const btnText = document.getElementById('btnText');
  const messageDiv = document.getElementById('message');
  const settingsBtn = document.getElementById('settingsBtn');
  const exportAllBtn = document.getElementById('exportAllBtn');

  // Open settings page
  settingsBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  });

  // Check if we're on AI Studio
  const checkAIStudioStatus = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.url) {
        updateStatus(false, 'Unable to detect current page');
        return false;
      }

      const isAIStudio = tab.url.includes('aistudio.google.com');
      const isPrompt = isAIStudio && tab.url.includes('/prompts/');
      const isLibrary = isAIStudio && tab.url.includes('/library');

      if (isPrompt) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
          if (response && response.isExporting) {
            updateStatus(true, 'Export in progress...', 'exporting');
            setLoading(true, true);
          } else {
            updateStatus(true, 'Connected to AI Studio', 'ready');
            setLoading(false);
          }
        } catch (e) {
          updateStatus(true, 'Connected to AI Studio', 'ready');
          setLoading(false);
        }
        exportAllBtn.style.display = 'none';
      } else if (isLibrary || isAIStudio) {
        // On library or main page - show batch export button
        updateStatus(true, 'On AI Studio - Batch export available', 'ready');
        exportBtn.disabled = true;
        exportAllBtn.style.display = 'block';
        exportAllBtn.disabled = false;

        // Check batch export status
        const batchStatus = await chrome.runtime.sendMessage({ action: 'getBatchStatus' });
        if (batchStatus && batchStatus.isRunning) {
          exportAllBtn.innerHTML = `⏳ Exporting ${batchStatus.currentIndex + 1}/${batchStatus.total}...`;
          exportAllBtn.classList.add('running');
        }
      } else {
        updateStatus(false, 'Please navigate to AI Studio', 'error');
        exportBtn.disabled = true;
        exportAllBtn.style.display = 'none';
      }

      return isAIStudio;
    } catch (error) {
      console.error('Error checking tab status:', error);
      updateStatus(false, 'Error checking page', 'error');
      return false;
    }
  };

  // Update status UI
  const updateStatus = (active, text, type = 'default') => {
    statusDiv.className = active ? 'status active' : 'status inactive';
    statusText.textContent = text;

    const iconSpan = statusDiv.querySelector('.status-icon');
    if (type === 'exporting') {
      iconSpan.textContent = '⏳';
    } else if (type === 'ready') {
      iconSpan.textContent = '✅';
    } else if (type === 'error') {
      iconSpan.textContent = '⚠️';
    } else {
      iconSpan.textContent = active ? '✅' : '⚠️';
    }
  };

  // Set button loading state
  const setLoading = (loading, isExporting = false) => {
    if (loading) {
      if (isExporting) {
        exportBtn.classList.add('stop-mode');
        exportBtn.classList.remove('loading');
        exportBtn.disabled = false;
        btnText.innerHTML = '🛑 Stop Export';
      } else {
        exportBtn.classList.add('loading');
        exportBtn.classList.remove('stop-mode');
        exportBtn.disabled = true;
        btnText.innerHTML = '<span class="spinner"></span> Starting...';
      }
    } else {
      exportBtn.classList.remove('loading');
      exportBtn.classList.remove('stop-mode');
      exportBtn.disabled = false;
      btnText.innerHTML = '🔄 Export Conversation';
    }
  };

  // Handle export button click
  exportBtn.addEventListener('click', async () => {
    try {
      // Get the active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        throw new Error('No active tab found');
      }

      // Check if we are in stop mode
      if (exportBtn.classList.contains('stop-mode')) {
        await chrome.tabs.sendMessage(tab.id, { action: 'cancel' });
        setLoading(false);
        updateStatus(true, 'Export cancelled', 'ready');
        return;
      }

      setLoading(true);
      messageDiv.style.display = 'none';

      // Send message to content script
      chrome.tabs.sendMessage(tab.id, { action: 'export' });

      // Close popup immediately as requested
      window.close();

    } catch (error) {
      setLoading(false);
      console.error('Export error:', error);

      // Check if it's a connection error (content script not loaded)
      if (error.message.includes('Could not establish connection')) {
        showMessage('error', '✗ Please refresh the AI Studio page and try again');
      } else {
        showMessage('error', `✗ Export failed: ${error.message}`);
      }
    }
  });

  // Handle Export All button
  exportAllBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      // Check if already running
      const batchStatus = await chrome.runtime.sendMessage({ action: 'getBatchStatus' });
      if (batchStatus && batchStatus.isRunning) {
        // Cancel
        await chrome.runtime.sendMessage({ action: 'cancelBatchExport' });
        exportAllBtn.innerHTML = '📦 Export All Conversations';
        exportAllBtn.classList.remove('running');
        return;
      }

      exportAllBtn.innerHTML = '⏳ Collecting conversation list...';
      exportAllBtn.disabled = true;

      // Extract conversation IDs from the library page
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const links = document.querySelectorAll('a[href*="/prompts/"]');
          const convs = [];
          const seen = new Set();
          links.forEach(a => {
            const href = a.getAttribute('href');
            const match = href.match(/\/prompts\/([a-zA-Z0-9_-]+)/);
            if (match) {
              const id = match[1];
              const name = a.textContent.trim();
              if (!seen.has(id) && name && name !== 'Playground' && !name.includes('View all')) {
                seen.add(id);
                convs.push({ id, name });
              }
            }
          });
          return convs;
        }
      });

      const conversations = results[0]?.result || [];

      if (conversations.length === 0) {
        exportAllBtn.innerHTML = '❌ No conversations found. Load library page fully.';
        setTimeout(() => {
          exportAllBtn.innerHTML = '📦 Export All Conversations';
          exportAllBtn.disabled = false;
        }, 3000);
        return;
      }

      exportAllBtn.innerHTML = `🚀 Starting export of ${conversations.length} conversations...`;

      // Start batch export via background script
      await chrome.runtime.sendMessage({
        action: 'startBatchExport',
        conversations: conversations,
        tabId: tab.id,
      });

      // Close popup - export runs in background
      window.close();

    } catch (error) {
      console.error('Batch export error:', error);
      exportAllBtn.innerHTML = `❌ Error: ${error.message}`;
      setTimeout(() => {
        exportAllBtn.innerHTML = '📦 Export All Conversations';
        exportAllBtn.disabled = false;
      }, 3000);
    }
  });

  // Initial status check
  await checkAIStudioStatus();

  // Recheck status when popup is opened
  chrome.tabs.onActivated.addListener(() => {
    checkAIStudioStatus();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
      checkAIStudioStatus();
    }
  });
});
