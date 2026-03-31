// AI Studio Exporter - Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const exportBtn = document.getElementById('exportBtn');
  const statusDiv = document.getElementById('status');
  const statusText = document.getElementById('statusText');
  const btnText = document.getElementById('btnText');
  const messageDiv = document.getElementById('message');
  const settingsBtn = document.getElementById('settingsBtn');

  const showMessage = (type, text) => {
    messageDiv.className = `message ${type}`;
    messageDiv.textContent = text;
    messageDiv.style.display = 'block';
  };

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

      const isAIStudio = isAIStudioUrl(tab.url);

      if (isAIStudio) {
        // Check if export is already running
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
          if (response && response.isExporting) {
            updateStatus(true, 'Export in progress...', 'exporting');
            setLoading(true, true); // true for loading, true for isExporting
          } else {
            updateStatus(true, 'Connected to AI Studio', 'ready');
            setLoading(false);
          }
        } catch (e) {
          // Content script might not be loaded yet or error
          updateStatus(true, 'Connected to AI Studio', 'ready');
          setLoading(false);
        }
      } else {
        updateStatus(false, 'Please navigate to an AI Studio prompt on aistudio.google.com', 'error');
        exportBtn.disabled = true;
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

      // Validate current tab before attempting export
      if (!isAIStudioUrl(tab.url)) {
        showMessage('error', '✗ Please open a prompt on aistudio.google.com before exporting');
        exportBtn.disabled = true;
        return;
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
  });  // Initial status check
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
