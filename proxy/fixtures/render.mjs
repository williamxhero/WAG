// External Crawl4AI renderer stand-in: real Chromium consumes the owned app's proxy config.
import { createRequire } from 'node:module';

const requireBrowser = createRequire(new URL('../../runtime/playwright-mcp/package.json', import.meta.url));
const { chromium } = requireBrowser('playwright');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { url, proxy, args } = JSON.parse(input);
const browser = await chromium.launch({
  executablePath: process.env.WAG_TEST_CHROMIUM_EXECUTABLE || chromium.executablePath(),
  headless: true,
  proxy: { server: proxy },
  args: [...args, `--ignore-certificate-errors-spki-list=${process.env.WAG_FIXTURE_SPKI}`, '--disable-background-networking'],
});
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(url, { timeout: 5000, waitUntil: 'load' });
  console.log(JSON.stringify({ success: true, markdown: await page.locator('body').innerText(), url: page.url(), screenshot: null, pdf: null }));
} catch (error) {
  console.log(JSON.stringify({ success: false, error_message: error.message }));
} finally {
  await browser.close();
}
