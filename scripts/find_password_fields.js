const puppeteer = require('puppeteer');

async function main() {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('facebook.com') || p.url().includes('meta.com'));
  
  console.log(`Main URL: ${page.url()}`);
  
  // Search main frame
  const mainInputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type,
      name: i.name,
      id: i.id,
      placeholder: i.placeholder
    }));
  });
  console.log('Main frame inputs:', mainInputs);
  
  // Search all frames
  const frames = page.frames();
  console.log(`Found ${frames.length} frames.`);
  for (let idx = 0; idx < frames.length; idx++) {
    const frame = frames[idx];
    try {
      const inputs = await frame.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type,
          name: i.name,
          id: i.id,
          placeholder: i.placeholder
        }));
      });
      console.log(`Frame [${idx}] URL: ${frame.url()}`);
      console.log(`Frame [${idx}] inputs:`, inputs);
    } catch (e) {
      console.log(`Could not access Frame [${idx}]: ${e.message}`);
    }
  }
  
  await browser.disconnect();
}

main().catch(console.error);
