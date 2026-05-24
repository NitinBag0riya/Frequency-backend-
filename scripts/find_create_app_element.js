const puppeteer = require('puppeteer');

async function main() {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('facebook.com') || p.url().includes('meta.com'));
  
  const elements = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('*'))
      .filter(e => e.innerText && e.innerText.trim() === 'Create App')
      .map(e => ({
        tagName: e.tagName,
        className: e.className,
        id: e.id,
        html: e.outerHTML.substring(0, 200)
      }));
  });
  
  console.log('Elements with text "Create App":', elements);
  await browser.disconnect();
}

main().catch(console.error);
