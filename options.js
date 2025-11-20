// Default settings
const DEFAULT_SETTINGS = {
    scrapeImages: true,
    scrapeAttachments: true,
    scrapeAttachmentPreview: true,
    scrapeAttachmentTitle: true,
    scrapeAttachmentSize: true,
    scrapeReasoning: true,
    loadDelay: 700
};

// DOM Elements
const elements = {
    scrapeImages: document.getElementById('scrapeImages'),
    scrapeAttachments: document.getElementById('scrapeAttachments'),
    scrapeAttachmentPreview: document.getElementById('scrapeAttachmentPreview'),
    scrapeAttachmentTitle: document.getElementById('scrapeAttachmentTitle'),
    scrapeAttachmentSize: document.getElementById('scrapeAttachmentSize'),
    scrapeReasoning: document.getElementById('scrapeReasoning'),
    loadDelay: document.getElementById('loadDelay'),
    attachmentOptions: document.getElementById('attachmentOptions'),
    saveBtn: document.getElementById('saveBtn'),
    resetBtn: document.getElementById('resetBtn'),
    statusMsg: document.getElementById('statusMsg')
};

// Load settings when page loads
document.addEventListener('DOMContentLoaded', loadSettings);

// Save settings when save button is clicked
elements.saveBtn.addEventListener('click', saveSettings);

// Reset settings when reset button is clicked
elements.resetBtn.addEventListener('click', resetSettings);

// Toggle attachment sub-options visibility
elements.scrapeAttachments.addEventListener('change', toggleAttachmentOptions);

function loadSettings() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
        elements.scrapeImages.checked = settings.scrapeImages;
        elements.scrapeAttachments.checked = settings.scrapeAttachments;
        elements.scrapeAttachmentPreview.checked = settings.scrapeAttachmentPreview;
        elements.scrapeAttachmentTitle.checked = settings.scrapeAttachmentTitle;
        elements.scrapeAttachmentSize.checked = settings.scrapeAttachmentSize;
        elements.scrapeReasoning.checked = settings.scrapeReasoning;
        elements.loadDelay.value = settings.loadDelay;

        toggleAttachmentOptions();
    });
}

function saveSettings() {
    const settings = {
        scrapeImages: elements.scrapeImages.checked,
        scrapeAttachments: elements.scrapeAttachments.checked,
        scrapeAttachmentPreview: elements.scrapeAttachmentPreview.checked,
        scrapeAttachmentTitle: elements.scrapeAttachmentTitle.checked,
        scrapeAttachmentSize: elements.scrapeAttachmentSize.checked,
        scrapeReasoning: elements.scrapeReasoning.checked,
        loadDelay: parseInt(elements.loadDelay.value, 10) || 700
    };

    chrome.storage.sync.set(settings, () => {
        showStatus('Settings saved successfully');
    });
}

function resetSettings() {
    if (confirm('Are you sure you want to reset all settings to default?')) {
        chrome.storage.sync.set(DEFAULT_SETTINGS, () => {
            loadSettings();
            showStatus('Settings reset to defaults');
        });
    }
}

function toggleAttachmentOptions() {
    const isEnabled = elements.scrapeAttachments.checked;
    const inputs = elements.attachmentOptions.querySelectorAll('input');

    elements.attachmentOptions.style.opacity = isEnabled ? '1' : '0.5';
    elements.attachmentOptions.style.pointerEvents = isEnabled ? 'auto' : 'none';

    inputs.forEach(input => {
        input.disabled = !isEnabled;
    });
}

function showStatus(message) {
    elements.statusMsg.textContent = message;
    elements.statusMsg.classList.add('show');
    setTimeout(() => {
        elements.statusMsg.classList.remove('show');
    }, 3000);
}
