// Rasterises public/icon.svg into the PNG sizes the web app manifest needs.
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Use the sandbox's pre-installed Chromium when it is there; otherwise let
 * Playwright fall back to whatever `playwright install` put in place (CI).
 */
function browserPath() {
  const p = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
  return existsSync(p) ? { executablePath: p } : {};
}


const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public', 'icon.svg'), 'utf8');

const targets = [
  { file: 'icon-192.png', size: 192, pad: 0 },
  { file: 'icon-512.png', size: 512, pad: 0 },
  // Maskable icons get cropped to a circle, so inset the artwork.
  { file: 'icon-maskable-512.png', size: 512, pad: 0.18 },
];

const browser = await chromium.launch({ ...browserPath() });
for (const t of targets) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  const inset = Math.round(t.size * t.pad);
  await page.setContent(
    `<body style="margin:0;background:#0e1014;width:${t.size}px;height:${t.size}px">
       <div style="position:absolute;inset:${inset}px">${svg.replace(/width="512" height="512"/, 'width="100%" height="100%"')}</div>
     </body>`,
  );
  const buf = await page.screenshot({ omitBackground: false });
  writeFileSync(join(root, 'public', t.file), buf);
  await page.close();
  console.log(`icons: wrote ${t.file} (${t.size}px)`);
}
await browser.close();
