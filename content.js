/***
 * Content script for AI Studio Exporter Extension
 * This script runs in the page context and extracts conversation data from Google AI Studio to be exported
 *
 * @author Sukarth Acharya
 * @version 1.0.1
 * @license MIT
 * @repository https://github.com/sukarth/ai-studio-exporter
 */

(function () {
  'use strict';

  // Configuration
  const CONFIG = {
    ELEMENT_LOAD_DELAY: 700, // Delay in ms for elements to load
  };

  // Global state
  let isExporting = false;
  let shouldCancel = false;

  // Utility function to sleep/wait
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Create and show loading overlay that blocks user input
  function showLoadingOverlay() {
    // Create overlay container
    const overlay = document.createElement('div');
    overlay.id = 'ai-studio-export-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.65);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      backdrop-filter: blur(8px);
      pointer-events: all;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    `;

    // Create loading content
    const content = document.createElement('div');
    content.style.cssText = `
      background: #25262b;
      padding: 40px;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      text-align: center;
      max-width: 400px;
      width: 90%;
      border: 1px solid #2c2e33;
      color: #e9ecef;
    `;

    // Loading spinner
    const spinner = document.createElement('div');
    spinner.style.cssText = `
      width: 50px;
      height: 50px;
      border: 3px solid rgba(102, 126, 234, 0.2);
      border-top: 3px solid #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 24px;
    `;

    // Add spinner animation to head
    if (!document.querySelector('#ai-studio-export-spinner-style')) {
      const style = document.createElement('style');
      style.id = 'ai-studio-export-spinner-style';
      style.textContent = `
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }

    // Title
    const title = document.createElement('h2');
    title.textContent = 'Exporting Conversation...';
    title.style.cssText = `
      margin: 0 0 12px 0;
      color: #fff;
      font-size: 20px;
      font-weight: 600;
    `;

    // Status message
    const message = document.createElement('p');
    message.id = 'ai-studio-export-status';
    message.textContent = 'Initializing export process...';
    message.style.cssText = `
      margin: 0;
      color: #a5a5a5;
      font-size: 14px;
      line-height: 1.6;
    `;

    // Progress indicator
    const progressContainer = document.createElement('div');
    progressContainer.style.cssText = `
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid #2c2e33;
    `;

    const progressText = document.createElement('div');
    progressText.id = 'ai-studio-export-progress';
    progressText.textContent = 'Starting...';
    progressText.style.cssText = `
      color: #667eea;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 20px;
    `;

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel Export';
    cancelBtn.style.cssText = `
      background: transparent;
      border: 1px solid #c92a2a;
      color: #ff8787;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
      font-weight: 500;
    `;
    cancelBtn.onmouseover = () => {
      cancelBtn.style.background = 'rgba(201, 42, 42, 0.1)';
    };
    cancelBtn.onmouseout = () => {
      cancelBtn.style.background = 'transparent';
    };
    cancelBtn.onclick = () => {
      shouldCancel = true;
      cancelBtn.textContent = 'Cancelling...';
      cancelBtn.disabled = true;
      cancelBtn.style.opacity = '0.7';
      cancelBtn.style.cursor = 'not-allowed';
    };

    progressContainer.appendChild(progressText);
    progressContainer.appendChild(cancelBtn);

    // Assemble content
    content.appendChild(spinner);
    content.appendChild(title);
    content.appendChild(message);
    content.appendChild(progressContainer);

    // Assemble overlay
    overlay.appendChild(content);

    // Block all user interactions
    overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('mouseup', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => e.stopPropagation());
    overlay.addEventListener('scroll', (e) => e.preventDefault());
    overlay.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    overlay.addEventListener('keydown', (e) => e.preventDefault());
    overlay.addEventListener('keyup', (e) => e.preventDefault());

    document.body.appendChild(overlay);

    return overlay;
  }

  // Update loading overlay status
  function updateLoadingStatus(message, progress) {
    const statusEl = document.getElementById('ai-studio-export-status');
    const progressEl = document.getElementById('ai-studio-export-progress');

    if (statusEl) {
      statusEl.textContent = message;
    }

    if (progressEl && progress) {
      progressEl.textContent = progress;
    }
  }

  // Hide and remove loading overlay
  function hideLoadingOverlay() {
    const overlay = document.getElementById('ai-studio-export-overlay');
    if (overlay) {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.3s ease';
      setTimeout(() => overlay.remove(), 300);
    }
  }

  // Extract user message text from ms-text-chunk element
  function extractUserMessageText(chatTurn) {
    const textChunk = chatTurn.querySelector('ms-text-chunk');
    if (textChunk) {
      return textChunk.innerText.trim();
    }
    return '';
  }

  // Extract model message text from ms-text-chunk element
  function extractModelMessageText(chatTurn) {
    const textChunk = chatTurn.querySelector('ms-text-chunk');
    if (textChunk) {
      return textChunk.innerText.trim();
    }
    return '';
  }

  // Convert blob URL to base64
  async function blobUrlToBase64(blobUrl) {
    try {
      const response = await fetch(blobUrl);
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.error('Error converting blob to base64:', error);
      return null;
    }
  }

  // Extract image from user message
  async function extractUserImage(chatTurn) {
    const imgElement = chatTurn.querySelector('img.loaded-image');
    if (!imgElement) {
      return null;
    }

    const src = imgElement.getAttribute('src');
    const alt = imgElement.getAttribute('alt') || 'image.jpg';

    if (src && src.startsWith('blob:')) {
      const base64Data = await blobUrlToBase64(src);
      return {
        alt: alt,
        base64: base64Data,
        filename: alt
      };
    }

    return null;
  }

  // Extract attachment from user message
  async function extractUserAttachment(chatTurn, settings) {
    const fileChunk = chatTurn.querySelector('ms-file-chunk');
    if (!fileChunk) {
      return null;
    }

    // Get file name/text
    let fileName = 'attachment';
    if (settings.scrapeAttachmentTitle) {
      const nameSpan = fileChunk.querySelector('span');
      fileName = nameSpan ? nameSpan.innerText.trim() : 'attachment';
    }

    // Get file size/tokens info
    let fileInfo = '';
    if (settings.scrapeAttachmentSize) {
      const fileChunkContainer = fileChunk.querySelector('.file-chunk-container');
      if (fileChunkContainer) {
        const lastChild = fileChunkContainer.lastChild;
        if (lastChild) {
          fileInfo = lastChild.innerText || '';
        }
      }
    }

    // Try to get preview image
    let previewBase64 = null;
    if (settings.scrapeAttachmentPreview) {
      const previewImg = fileChunk.querySelector('img');
      if (previewImg) {
        const imgSrc = previewImg.getAttribute('src');
        if (imgSrc) {
          if (imgSrc.startsWith('blob:')) {
            // Handle blob URLs
            previewBase64 = await blobUrlToBase64(imgSrc);
          } else if (imgSrc.startsWith('http://') || imgSrc.startsWith('https://')) {
            // Handle HTTP/HTTPS URLs (e.g., Google Drive links)
            try {
              const response = await fetch(imgSrc);
              const blob = await response.blob();
              previewBase64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
            } catch (error) {
              console.error('Error downloading preview image:', error);
            }
          }
        }
      }
    }

    return {
      fileName: fileName,
      fileInfo: fileInfo,
      previewBase64: previewBase64
    };
  }

  // Extract reasoning text from model message
  async function extractReasoningText(chatTurn) {
    // Find the chevron button
    const chevronButton = Array.from(chatTurn.querySelectorAll('span')).find(
      span => span.textContent.trim() === 'chevron_right'
    );

    if (!chevronButton) {
      return null;
    }

    // Click to expand
    chevronButton.click();
    await sleep(CONFIG.ELEMENT_LOAD_DELAY); // Wait for expansion animation

    // Find the reasoning text
    const expansionPanel = chatTurn.querySelector('.mat-expansion-panel-body ms-text-chunk');
    let reasoningText = null;

    if (expansionPanel) {
      // Get text content and preserve formatting, but remove outer whitespace
      reasoningText = expansionPanel.textContent.replace(/^\s+/, '').replace(/\s+$/, '');
    }

    // Click again to collapse
    chevronButton.click();
    await sleep(CONFIG.ELEMENT_LOAD_DELAY);

    return reasoningText;
  }

  // Get settings from storage
  function getSettings() {
    return new Promise((resolve) => {
      const DEFAULT_SETTINGS = {
        scrapeImages: true,
        scrapeAttachments: true,
        scrapeAttachmentPreview: true,
        scrapeAttachmentTitle: true,
        scrapeAttachmentSize: true,
        scrapeReasoning: true,
        loadDelay: 700
      };

      chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
        resolve(settings);
      });
    });
  }

  // Process a single chat turn
  async function processChatTurn(chatTurn, imageCounter, settings) {
    // Scroll the chat turn into view before processing
    chatTurn.scrollIntoView();
    await sleep(CONFIG.ELEMENT_LOAD_DELAY); // Wait for scroll to complete

    const turnContainer = chatTurn.querySelector('[data-turn-role]');
    if (!turnContainer) {
      return null;
    }

    const role = turnContainer.getAttribute('data-turn-role');

    if (role === 'User') {
      // Check for image first (if enabled)
      if (settings.scrapeImages) {
        const imageData = await extractUserImage(chatTurn);

        if (imageData) {
          return {
            type: 'user',
            contentType: 'image',
            image: imageData
          };
        }
      }

      // Check for attachment (if enabled)
      if (settings.scrapeAttachments) {
        const attachmentData = await extractUserAttachment(chatTurn, settings);

        if (attachmentData) {
          return {
            type: 'user',
            contentType: 'attachment',
            attachment: attachmentData
          };
        }
      }

      // Extract text
      const text = extractUserMessageText(chatTurn);
      if (text) {
        return {
          type: 'user',
          contentType: 'text',
          text: text
        };
      }

      // If no text or attachment found, return null
      return null;
    } else if (role === 'Model') {
      // Check for reasoning block (if enabled)
      if (settings.scrapeReasoning) {
        const reasoningText = await extractReasoningText(chatTurn);

        if (reasoningText) {
          return {
            type: 'model',
            contentType: 'reasoning',
            text: reasoningText
          };
        }
      }

      // Extract model response
      const text = extractModelMessageText(chatTurn);
      if (text) {
        return {
          type: 'model',
          contentType: 'response',
          text: text
        };
      }
    }

    return null;
  }

  // Check if raw mode is already enabled
  function isRawModeEnabled() {
    return document.body.innerHTML.includes("Show conversation with markdown formatting");
  }

  // Main export function
  async function exportConversation() {
    if (isExporting) {
      return { success: false, message: 'Export already in progress' };
    }

    try {
      isExporting = true;
      shouldCancel = false;

      // Load settings
      const settings = await getSettings();

      // Update config with loaded delay
      CONFIG.ELEMENT_LOAD_DELAY = settings.loadDelay;

      // Show loading overlay
      const overlay = showLoadingOverlay();
      updateLoadingStatus('Enabling raw output mode...', 'Step 1/4: Setup');

      // Step 1: Check initial raw mode state and toggle if needed
      console.log('Checking raw output mode state...');
      const moreActionsButton = document.querySelector('button[aria-label="View more actions"]');
      if (!moreActionsButton) {
        throw new Error('Could not find "View more actions" button');
      }

      moreActionsButton.click();
      await sleep(CONFIG.ELEMENT_LOAD_DELAY / 5);

      const rawOutputButton = document.querySelector('button[aria-label="Toggle viewing raw output"]');
      if (!rawOutputButton) {
        throw new Error('Could not find "Toggle viewing raw output" button');
      }

      // Store the initial state (true = already on, false = currently off)
      const initialRawModeEnabled = isRawModeEnabled();
      console.log(`Initial raw mode state: ${initialRawModeEnabled ? 'ON' : 'OFF'}`);

      // Toggle raw mode only if it's not already enabled
      if (!initialRawModeEnabled) {
        console.log('Toggling raw output mode ON...');
        rawOutputButton.click();
        await sleep(CONFIG.ELEMENT_LOAD_DELAY * 5); // Wait for raw output to load (longer delay needed)

        // Verify that raw mode was enabled successfully
        const rawModeAfterToggle = isRawModeEnabled();
        console.log(`Raw mode after toggle: ${rawModeAfterToggle ? 'ON' : 'OFF'}`);
        if (!rawModeAfterToggle) {
          throw new Error('Failed to enable raw output mode');
        }
      } else {
        console.log('Raw output mode already ON, skipping toggle');
      }


      if (shouldCancel) throw new Error('Export cancelled by user');

      // Step 2: Find all chat turns
      updateLoadingStatus('Scanning conversation...', 'Step 2/4: Scanning');
      console.log('Finding chat turns...');
      const chatTurns = document.querySelectorAll('ms-chat-turn');
      console.log(`Found ${chatTurns.length} chat turns`);

      if (chatTurns.length === 0) {
        throw new Error('No chat turns found');
      }

      if (shouldCancel) throw new Error('Export cancelled by user');

      // Step 3: Process all chat turns
      updateLoadingStatus('Extracting messages and images...', `Step 3/4: Processing (0/${chatTurns.length})`);
      const conversationData = [];
      const images = [];
      let imageCounter = 0;

      for (let i = 0; i < chatTurns.length; i++) {
        if (shouldCancel) throw new Error('Export cancelled by user');

        updateLoadingStatus(
          'Extracting messages and images...',
          `Step 3/4: Processing (${i + 1}/${chatTurns.length})`
        );
        console.log(`Processing turn ${i + 1}/${chatTurns.length}`);
        const turnData = await processChatTurn(chatTurns[i], imageCounter, settings);

        if (turnData) {
          if (turnData.contentType === 'image') {
            imageCounter++;
            const imageName = `image-${imageCounter}.jpg`;
            images.push({
              name: imageName,
              base64: turnData.image.base64
            });
            conversationData.push({
              type: 'user',
              contentType: 'image',
              imageName: imageName
            });
          } else if (turnData.contentType === 'attachment') {
            // Handle attachment
            const attachment = turnData.attachment;
            if (attachment.previewBase64) {
              imageCounter++;
              const previewName = `image-${imageCounter}.jpg`;
              images.push({
                name: previewName,
                base64: attachment.previewBase64
              });
              conversationData.push({
                type: 'user',
                contentType: 'attachment',
                fileName: attachment.fileName,
                fileInfo: attachment.fileInfo,
                previewName: previewName
              });
            } else {
              conversationData.push({
                type: 'user',
                contentType: 'attachment',
                fileName: attachment.fileName,
                fileInfo: attachment.fileInfo,
                previewName: null
              });
            }
          } else {
            conversationData.push(turnData);
          }
        }
      }

      if (shouldCancel) throw new Error('Export cancelled by user');

      // Step 4: Generate Markdown and create ZIP
      updateLoadingStatus('Creating ZIP file...', 'Step 4/4: Packaging');
      console.log('Generating markdown...');

      // Get conversation title and token size
      const titleElement = document.querySelector('.actions.pointer.mode-title');
      const tokenElement = document.querySelector('.token-container');
      const conversationTitle = titleElement ? titleElement.innerText.trim() : 'Untitled Conversation';
      const tokenSize = tokenElement ? tokenElement.innerText.trim() : 'Unknown';

      let markdown = `# **Title:** ${conversationTitle}\n\n`;
      markdown += `**Token Size:** ${tokenSize}\n\n`;
      markdown += `Exported on: ${new Date().toLocaleString()}\n\n`;
      markdown += '---\n\n';

      for (const item of conversationData) {
        if (item.type === 'user') {
          if (item.contentType === 'image') {
            markdown += `## 👤 User\n\n`;
            markdown += `**Image Attachment:**\n\n File Name: ${item.imageName}\n\n Image: ![${item.imageName}](${item.imageName})\n\n`;
          } else if (item.contentType === 'attachment') {
            markdown += `## 👤 User\n\n`;
            markdown += `**File Attachment:** ${item.fileName}\n\n`;
            if (item.fileInfo) {
              markdown += `File Size: _${item.fileInfo}_\n\n`;
            }
            if (item.previewName) {
              markdown += `File Name: ![${item.fileName}](${item.previewName})\n\n`;
            }
          } else {
            markdown += `## 👤 User\n\n`;
            markdown += `${item.text}\n\n`;
          }
        } else if (item.type === 'model') {
          if (item.contentType === 'reasoning') {
            markdown += `## 🤖 Model (Reasoning)\n\n`;
            markdown += `${item.text}\n\n`;
          } else {
            markdown += `## 🤖 Model\n\n`;
            markdown += `${item.text}\n\n`;
          }
        }
      }

      // Step 5: Create ZIP file
      console.log('Creating ZIP file...');
      const zip = new JSZip();

      // Add markdown file
      zip.file('conversation.md', markdown);

      // Add images
      for (const image of images) {
        if (image.base64) {
          // Remove data URL prefix (e.g., "data:image/png;base64,")
          const base64Data = image.base64.split(',')[1];
          zip.file(image.name, base64Data, { base64: true });
        }
      }

      // Generate ZIP
      const zipBlob = await zip.generateAsync({ type: 'blob' });

      if (shouldCancel) throw new Error('Export cancelled by user');

      // Step 6: Download ZIP
      updateLoadingStatus('Download starting...', 'Finalizing...');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `ai-studio-export-${timestamp}.zip`;

      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      console.log('Export completed successfully!');

      // Step 5: Revert raw mode to original state if it was toggled
      if (!initialRawModeEnabled) {
        console.log('Reverting raw output mode to original state...');
        // Need to open the menu again and toggle back
        const moreActionsButtonRevert = document.querySelector('button[aria-label="View more actions"]');
        if (moreActionsButtonRevert) {
          moreActionsButtonRevert.click();
          await sleep(CONFIG.ELEMENT_LOAD_DELAY);

          const rawOutputButtonRevert = document.querySelector('button[aria-label="Toggle viewing raw output"]');
          if (rawOutputButtonRevert) {
            rawOutputButtonRevert.click();
            await sleep(CONFIG.ELEMENT_LOAD_DELAY);

            // Verify that raw mode was disabled successfully
            const rawModeAfterRevert = isRawModeEnabled();
            console.log(`Raw mode after revert: ${rawModeAfterRevert ? 'ON' : 'OFF'}`);
            if (rawModeAfterRevert) {
              console.warn('Warning: Failed to disable raw output mode');
            }
          }
        }
      }

      return {
        success: true,
        message: `Exported ${conversationData.length} messages with ${images.length} images`,
        filename: filename
      };

    } catch (error) {
      console.error('Export failed:', error);
      return {
        success: false,
        message: error.message
      };
    } finally {
      isExporting = false;
      shouldCancel = false;
      hideLoadingOverlay();
    }
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'export') {
      exportConversation().then(sendResponse);
      return true; // Will respond asynchronously
    } else if (request.action === 'getStatus') {
      sendResponse({ isExporting });
    } else if (request.action === 'cancel') {
      shouldCancel = true;
      sendResponse({ success: true });
    }
  }); console.log('AI Studio Exporter content script loaded');
})();
