/**
 * Makes the PDF fonts in fonts/: Noto Sans (regular and bold) and Noto Sans
 * Mono, cut down to the scripts the PDF can draw correctly.
 *
 * The standard PDF fonts only know Latin-1, so before these existed a Russian
 * or Greek conversation came out of the PDF export as question marks. Noto
 * covers Latin, Greek, Cyrillic and Vietnamese in one family. Other scripts
 * are deliberately left out:
 *
 *   - Chinese, Japanese and Korean need a font of several megabytes each.
 *   - Devanagari, Arabic, Hebrew and Thai need shaping and bidirectional
 *     layout that pdf-lib does not do: Hindi drawn with this font came out
 *     readable but with its conjuncts broken, which is worse than an honest
 *     warning pointing at the Word export.
 *
 * The output is committed, like vendor/, so a clone works without running
 * this. Rerun it only to change the coverage. Needs Python with fontTools
 * (`pip install fonttools`) and the font packages from `npm install`.
 *
 *     npm run fonts
 *
 * @license MIT
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SOURCE = path.join(ROOT, 'node_modules', '@expo-google-fonts');

const FONTS = [
  ['noto-sans/400Regular/NotoSans_400Regular.ttf', 'NotoSans-Regular.ttf'],
  ['noto-sans/700Bold/NotoSans_700Bold.ttf', 'NotoSans-Bold.ttf'],
  ['noto-sans-mono/400Regular/NotoSansMono_400Regular.ttf', 'NotoSansMono-Regular.ttf'],
];

// Latin (with every extension block), Greek, Cyrillic, combining marks,
// punctuation, currency and letterlike symbols.
const UNICODES = [
  'U+0000-024F', 'U+0250-02FF', 'U+0300-036F', 'U+0370-03FF', 'U+0400-052F',
  'U+1C80-1C8F', 'U+1E00-1EFF', 'U+1F00-1FFF', 'U+2000-206F', 'U+2070-209F',
  'U+20A0-20CF', 'U+2100-218F', 'U+2C60-2C7F', 'U+2DE0-2DFF', 'U+A640-A69F',
  'U+A720-A7FF', 'U+AB30-AB6F', 'U+FB00-FB06', 'U+FEFF', 'U+FFFD',
].join(',');

for (const [from, to] of FONTS) {
  const input = path.join(SOURCE, from);
  if (!fs.existsSync(input)) {
    console.error(`missing ${input}: run npm install first`);
    process.exit(1);
  }
  const output = path.join(ROOT, 'fonts', to);
  execFileSync(
    'python',
    ['-m', 'fontTools.subset', input, `--unicodes=${UNICODES}`, '--layout-features=*', '--no-hinting', `--output-file=${output}`],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
  console.log(`fonts/${to}  ${(fs.statSync(output).size / 1024).toFixed(0)} kB`);
}

fs.copyFileSync(path.join(SOURCE, 'noto-sans', 'LICENSE_FONT'), path.join(ROOT, 'fonts', 'NotoSans-OFL.txt'));
console.log('fonts/NotoSans-OFL.txt');
