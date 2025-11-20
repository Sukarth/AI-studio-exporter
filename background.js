// AI Studio Exporter - Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log('AI Studio Exporter installed');
});

// Handle messages from popup or content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'checkTab') {
    // Check if current tab is AI Studio
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        const isAIStudio = tabs[0].url && tabs[0].url.includes('aistudio.google.com');
        sendResponse({ isAIStudio: isAIStudio, url: tabs[0].url });
      } else {
        sendResponse({ isAIStudio: false });
      }
    });
    return true; // Will respond asynchronously
  }
});

console.log('AI Studio Exporter background service worker loaded');
