const puppeteer = require('puppeteer');

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('facebook.com') || p.url().includes('meta.com'));
  
  console.log('1. Navigating to Apps...');
  await page.goto('https://developers.facebook.com/apps/', { waitUntil: 'domcontentloaded' });
  await delay(4000);
  
  console.log('2. Clicking "Create App"...');
  await page.evaluate(() => {
    // Find the innermost element with exact text "Create App"
    const el = Array.from(document.querySelectorAll('*'))
      .find(e => e.children.length === 0 && e.innerText && e.innerText.trim() === 'Create App');
    if (el) {
      el.click();
      let parent = el.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        parent.click();
        parent = parent.parentElement;
      }
    }
  });
  
  await delay(4000);
  await page.screenshot({ path: 'scratch/test_click_1.png' });
  console.log('Saved screenshot 1');
  
  console.log('3. Clicking "Other"...');
  const clickedOther = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*'))
      .find(e => e.children.length === 0 && e.innerText && e.innerText.trim() === 'Other');
    if (el) {
      el.click();
      let parent = el.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        parent.click();
        parent = parent.parentElement;
      }
      return true;
    }
    return false;
  });
  console.log(`Clicked Other: ${clickedOther}`);
  
  await delay(1000);
  
  console.log('4. Clicking Next...');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*'))
      .find(e => e.children.length === 0 && e.innerText && e.innerText.trim() === 'Next');
    if (el) {
      el.click();
      let parent = el.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        parent.click();
        parent = parent.parentElement;
      }
    }
  });
  
  await delay(3000);
  await page.screenshot({ path: 'scratch/test_click_2.png' });
  console.log('Saved screenshot 2');
  
  console.log('5. Clicking "Business"...');
  const clickedBusiness = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*'))
      .find(e => e.children.length === 0 && e.innerText && e.innerText.trim() === 'Business');
    if (el) {
      el.click();
      let parent = el.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        parent.click();
        parent = parent.parentElement;
      }
      return true;
    }
    return false;
  });
  console.log(`Clicked Business: ${clickedBusiness}`);
  
  await delay(1000);
  
  console.log('6. Clicking Next...');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*'))
      .find(e => e.children.length === 0 && e.innerText && e.innerText.trim() === 'Next');
    if (el) {
      el.click();
      let parent = el.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        parent.click();
        parent = parent.parentElement;
      }
    }
  });
  
  await delay(3000);
  await page.screenshot({ path: 'scratch/test_click_3.png' });
  console.log('Saved screenshot 3');
  
  await browser.disconnect();
}

main().catch(console.error);
