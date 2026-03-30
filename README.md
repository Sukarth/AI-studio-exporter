# 📦 AI Studio Exporter

A browser extension that exports conversations from Google AI Studio, including all media attachments and chat history in a convenient ZIP file.

![Demo of AI Studio Exporter](https://raw.githubusercontent.com/Sukarth/AI-studio-exporter/main/images/Demo.gif)

## ✨ Features

- 🔄 **Complete Export**: Exports entire conversation history from Google AI Studio.
- 📦 **Batch Export All**: Export ALL conversations at once from the Library page - no need to open each one manually.
- 🖼️ **Media Preservation**: Includes all image attachments in the export.
- 📝 **Markdown Format**: Conversations are saved in readable Markdown format.
- 🤖 **Reasoning Support**: Captures model reasoning blocks when available.
- 📦 **ZIP Archive**: Everything packaged in a single ZIP file (single export) or JSON + Markdown files (batch export).
- 🎨 **User-Friendly**: Simple, intuitive popup interface.
- ⚡ **Fast & Efficient**: Optimized for performance and works entirely client-side.
- 🔒 **Privacy-Focused**: NO data is collected or sent to any external servers.

## 🚀 Installation (from Source)

Follow these steps to install and run the extension locally. Installation from Chrome Web Store is coming soon...

### Step 1: Get the Code

Clone the repository to your local machine:
```bash
git clone https://github.com/sukarth/ai-studio-exporter.git
cd ai-studio-exporter
```

### Step 2: Load the Extension in Chrome

1.  **Open Chrome Extensions Page**: Navigate to `chrome://extensions/`.
2.  **Enable Developer Mode**: Toggle the "Developer mode" switch in the top-right corner.
3.  **Load the Extension**:
    *   Click the "Load unpacked" button.
    *   Select the `ai-studio-exporter` folder that you cloned.
4.  **Verify**: The "AI Studio Exporter" should now appear in your list of extensions. Pin it to your toolbar for easy access.

## 🔄 Updating

When a new version is released:

1. Download the latest version (git clone)
2. Go to `chrome://extensions/`
3. Find "AI Studio Exporter"
4. Click "Remove"
5. Add the extension again by clicking "Load unpacked" and selecting the new/same `ai-studio-exporter` folder

Alternatively, if using Git:

```bash
git pull origin main
# Reload the extension in chrome://extensions/
```

## 📖 Usage

### Single Conversation Export

1.  **Navigate to Google AI Studio**: Go to a conversation you want to export (e.g., `https://aistudio.google.com/prompts/...`).
2.  **Click the Extension Icon**: The popup will show a "Connected to AI Studio" status.
3.  **Export**: Click the "Export Conversation" button. The ZIP file containing your conversation and images will be downloaded automatically after the export completes.

### Batch Export (Export All Conversations)

1.  **Navigate to AI Studio Library**: Go to `https://aistudio.google.com/library`.
2.  **Click the Extension Icon**: You'll see a green "Export All Conversations" button.
3.  **Click "Export All Conversations"**: The extension will automatically open each conversation, extract the content, and move to the next one.
4.  **Wait for completion**: A JSON file and a Markdown file containing all your conversations will be downloaded automatically when done. The export runs in the background - you can close the popup.

> **Note**: Batch export may take 15-30 minutes depending on how many conversations you have. You can cancel anytime by clicking the extension icon and pressing the cancel button.

## 📂 Export Structure

Your downloaded ZIP file will have the following structure:

```
ai-studio-export-YYYY-MM-DDTHH-mm-ss.zip
├── conversation.md          # Full conversation in Markdown
├── image1.jpg               # User-uploaded image 1 (if any)
├── image2.png               # User-uploaded image 2 (if any)
└── ...                      # Additional media files (if any, such as attached document previews)
```

## 🤝 Contributing

Contributions are welcome! We appreciate any help, from reporting bugs to submitting pull requests. Please read our [CONTRIBUTING.md](CONTRIBUTING.md) file for guidelines on how to get started.


## 🛠️ Technical Details

- **Manifest V3**: Built using the latest Chrome extension architecture.
- **JSZip**: Used for client-side ZIP file generation.
- **Content Scripts**: For DOM manipulation and data extraction from the AI Studio page.
- **Service Worker**: For background task coordination.
- **Vanilla JS**: No heavy frameworks, keeping the extension lightweight.

### Permissions

- `activeTab`: To access the current AI Studio tab.
- `scripting`: To inject content scripts for data extraction.
- `downloads`: To trigger the ZIP file download.
- `storage`: To save user settings.
- `tabs`: To manage tab navigation during batch export.
- `host_permissions`: To run on the `aistudio.google.com` domain.

## 🐛 Troubleshooting & known issues

- **Exported markdown file is missing formatting and spacing for messages**: This is a known issue. We are working on a fix. 
    - **Workaround**: refresh the AI Studio page and ensure that when the page is fully loaded, raw mode is turned off by default. If not, turn it off manually and then reload the page.
    - **Note**: Ensure the page is fully loaded before starting the export!
-   **Export button is disabled or "Not on AI Studio" message**: Make sure you are on a valid AI Studio conversation page and that the page has fully loaded. Try refreshing the page.
-   **Export fails or hangs**: Wait for the AI Studio page to load completely before starting the export. If the issue persists, check the browser's developer console (F12) for errors and open a GitHub issue.

## 📝 License

This project is open source and available under the [MIT License](LICENSE).

---

**Made with ❤️ by Sukarth Acharya**
