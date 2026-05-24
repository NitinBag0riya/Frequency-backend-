const puppeteer = require('puppeteer');

async function main() {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('facebook.com') || p.url().includes('meta.com'));
  
  console.log('Clicking "Create App"...');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button, a, div')).find(e => e.innerText && e.innerText.includes('Create App'));
    if (el) el.click();
  });
  
  await new Promise(resolve => setTimeout(resolve, 4000));
  
  const text = await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]') || document.body;
    return modal.innerText;
  });
  
  console.log('Dialog InnerText:\n', text);
  await browser.disconnect();
}

main().catch(console.error);
