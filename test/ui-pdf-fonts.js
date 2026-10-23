/**
 * PDF export of a non-Latin conversation, end to end, in a real Chrome.
 *
 * The Node suite (test/documents.js) proves the renderer embeds Noto Sans when
 * handed the font bytes. This proves the part only a browser can: that the
 * content script running on AI Studio can actually fetch the font files out of
 * the extension, so a Russian chat comes out readable instead of as "?".
 *
 * Same trick as test/ui-export.js: Playwright fulfils AI Studio's page and API
 * itself, so no Google account is needed. Pro is granted by writing a licence
 * into storage, as an activation would.
 *
 *     npm run test:ui:pdf
 *
 * Set AISE_EXTENSION_DIR to run it against an unpacked store package, and
 * AISE_PDF_OUT to keep the exported PDFs for a look.
 *
 * @license MIT
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const EXTENSION = process.env.AISE_EXTENSION_DIR || ROOT;

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  console.log('playwright not installed - run `npm install`. Skipping PDF font UI tests.');
  process.exit(0);
}

const PROMPT_ID = 'TESTPROMPT0000000000000000000003';

/** The positional-array shape ResolveDriveResource returns (see ui-export.js). */
function wirePrompt(title, userText, modelText) {
  const turn = (over) => Object.assign(new Array(36).fill(null), { 8: 'user' }, over);
  const part = (text) => {
    const p = new Array(15).fill(null);
    p[1] = text;
    return p;
  };
  const runSettings = new Array(35).fill(null);
  runSettings[0] = 1;
  runSettings[2] = 'models/gemini-3-pro';
  const metadata = new Array(12).fill(null);
  metadata[0] = title;
  metadata[4] = [[1784534516, 0], null];
  const prompt = new Array(14).fill(null);
  prompt[0] = `prompts/${PROMPT_ID}`;
  prompt[3] = runSettings;
  prompt[4] = metadata;
  prompt[13] = [
    [
      turn({ 0: userText, 18: 8 }),
      turn({ 0: modelText, 8: 'model', 16: 1, 18: 9, 29: [part(modelText)] }),
    ],
    [],
  ];
  return [prompt];
}

const CONVERSATIONS = {
  russian: wirePrompt(
    'Экспорт разговора',
    'Как экспортировать чат? Γειά σου. Tiếng Việt.',
    'Вот так: **жирный**, *курсив* и `код_пример`.\n\n```\nconst привет = "мир";\n```'
  ),
  chinese: wirePrompt('Chinese chat', 'Привет 你好', 'Ответ 世界'),
};

function pdfText(bytes) {
  const parts = [bytes.toString('latin1')];
  let cursor = 0;
  while (true) {
    const start = bytes.indexOf('stream', cursor);
    if (start === -1) break;
    let from = start + 6;
    if (bytes[from] === 13) from++;
    if (bytes[from] === 10) from++;
    const end = bytes.indexOf('endstream', from);
    if (end === -1) break;
    try {
      parts.push(zlib.inflateSync(bytes.subarray(from, end)).toString('latin1'));
    } catch (_) { /* not deflated */ }
    cursor = end + 9;
  }
  return parts.join('\n');
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-pdf-'));
  const downloadDir = process.env.AISE_PDF_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'aise-pdf-dl-'));
  fs.mkdirSync(downloadDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });

    let current = 'russian';
    await context.route('https://aistudio.google.com/**', (route) =>
      route.request().resourceType() === 'document'
        ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>AI Studio</title><body></body>' })
        : route.abort()
    );
    await context.route('https://alkalimakersuite-pa.clients6.google.com/**', (route) => {
      const method = route.request().url().split('/').pop();
      if (method === 'ResolveDriveResource') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONVERSATIONS[current]) });
      }
      if (method === 'GenerateAccessToken') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['fake-token', 3600]) });
      }
      return route.fulfill({ status: 404, body: '[]' });
    });
    // Pro, as an activation leaves it; fresh, so nothing tries to revalidate.
    await context.route('https://api.polar.sh/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await context.addCookies([{ name: 'SAPISID', value: 'fake-sapisid-value', domain: '.google.com', path: '/', secure: true }]);
    await worker.evaluate(() => chrome.storage.local.set({
      proLicense: { key: 'TEST-KEY-12345678', activationId: 'act_1', activatedAt: Date.now(), lastCheckedAt: Date.now(), valid: true },
    }));

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`https://aistudio.google.com/prompts/${PROMPT_ID}`);

    const exportPdf = async (name) => {
      current = name;
      const [download, result] = await Promise.all([
        context.waitForEvent('download', { timeout: 60000 }),
        worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' });
          return chrome.tabs.sendMessage(tab.id, { action: 'export', formatId: 'pdf' });
        }),
      ]);
      const file = path.join(downloadDir, `${name}.pdf`);
      await download.saveAs(file);
      return { result, file, bytes: fs.readFileSync(file) };
    };

    let russian;
    await test('a Russian conversation exports as a PDF, not a downgraded Markdown file', async () => {
      russian = await exportPdf('russian');
      assert.strictEqual(russian.result.success, true, russian.result.message);
      assert.strictEqual(russian.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    });

    await test('the content script loaded the extension\'s fonts and embedded them', async () => {
      const text = pdfText(russian.bytes);
      assert.ok(/FontFile2/.test(text), 'a TrueType font program is embedded');
      assert.ok(/NotoSans/.test(text), 'and it is Noto Sans');
      assert.ok(/NotoSansMono/.test(text), 'code uses the mono face');
    });

    await test('no warning: everything in it is drawable', async () => {
      assert.ok(!russian.result.warning, `unexpected warning: ${russian.result.warning}`);
    });

    await test('Chinese is still flagged, and the PDF is still produced', async () => {
      const chinese = await exportPdf('chinese');
      assert.strictEqual(chinese.result.success, true);
      assert.ok(chinese.result.warning && chinese.result.warning.includes('你'), `warning was: ${chinese.result.warning}`);
      assert.ok(/NotoSans/.test(pdfText(chinese.bytes)), 'the Cyrillic beside it still gets the font');
    });

    await test('no content script threw', async () => {
      assert.deepStrictEqual(pageErrors, []);
    });
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    if (!process.env.AISE_PDF_OUT) fs.rmSync(downloadDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const { name, error } of failures) console.log(`\n${name}\n  ${(error && error.stack) || error}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
