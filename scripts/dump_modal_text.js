const puppeteer = require('puppeteer');

async function main() {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('facebook.com') || p.url().includes('meta.com'));
  
  console.log(`Current URL: ${page.url()}`);
  
  const modalText = await page.evaluate(() => {
    // Look for modals, dialogs, overlays, or portals
    const overlays = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .dialog, [class*="modal"], [class*="dialog"]'));
    if (overlays.length > 0) {
      return overlays.map((o, i) => `Modal [${i}]:\n${o.innerText}`).join('\n\n');
    }
    return 'No modal elements found on page using standard selectors.';
  });
  
  console.log('Modal text found:\n', modalText);
  
  // Dump visible text of the page
  const visibleText = await page.evaluate(() => {
    return document.body.innerText;
  });
  console.log('\nFull visible text:\n', visibleText.substring(0, 1000));
  
  await browser.disconnect();
}

main().catch(console.error);
