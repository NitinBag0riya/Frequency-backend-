const fs = require('fs');
const puppeteer = require('puppeteer');

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Connecting to Chrome...');
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });
  
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('facebook.com') || p.url().includes('meta.com'));
  if (!page) {
    page = await browser.newPage();
  }
  
  console.log('Navigating to Developers Apps page...');
  await page.goto('https://developers.facebook.com/apps/', { waitUntil: 'domcontentloaded' });
  await delay(5000);
  await page.screenshot({ path: 'scratch/step_0_dashboard.png' });
  console.log('Step 0: Dashboard screenshot saved.');
  
  // Click Create App
  console.log('Clicking "Create App"...');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button, a, div')).find(e => e.innerText && e.innerText.includes('Create App'));
    if (el) el.click();
    else throw new Error('Create App button not found');
  });
  await delay(3000);
  await page.screenshot({ path: 'scratch/step_1_create_dialog.png' });
  console.log('Step 1: Create dialog screenshot saved.');
  
  // Click Other
  console.log('Selecting "Other"...');
  const clickedOther = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('span, div, label')).find(e => e.innerText && e.innerText.trim() === 'Other');
    if (el) {
      el.click();
      return true;
    }
    return false;
  });
  console.log(`Clicked Other: ${clickedOther}`);
  await delay(1000);
  
  // Click Next
  console.log('Clicking Next...');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button, div')).find(e => e.innerText && e.innerText.trim() === 'Next');
    if (el) el.click();
  });
  await delay(2000);
  await page.screenshot({ path: 'scratch/step_2_other_selected.png' });
  
  // Select Business
  console.log('Selecting "Business"...');
  const clickedBusiness = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('span, div, label')).find(e => e.innerText && e.innerText.trim() === 'Business');
    if (el) {
      el.click();
      return true;
    }
    return false;
  });
  console.log(`Clicked Business: ${clickedBusiness}`);
  await delay(1000);
  
  // Click Next
  console.log('Clicking Next...');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button, div')).find(e => e.innerText && e.innerText.trim() === 'Next');
    if (el) el.click();
  });
  await delay(2000);
  await page.screenshot({ path: 'scratch/step_3_business_selected.png' });
  
  // Fill Display Name
  console.log('Filling display name...');
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
    if (inputs.length > 0) {
      inputs[0].value = 'Frequency Production';
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await delay(1000);
  
  // Select Business Portfolio
  console.log('Selecting Business Portfolio...');
  const portfolioResult = await page.evaluate(() => {
    // Look for a dropdown or select
    const select = document.querySelector('select');
    if (select) {
      const opt = Array.from(select.options).find(o => o.text.includes('Frequency') || o.text.includes('Arihant'));
      if (opt) {
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return `Selected option: ${opt.text}`;
      }
      return `Dropdown found but no matching options. Available: ${Array.from(select.options).map(o => o.text).join(', ')}`;
    }
    return 'Select element not found';
  });
  console.log(`Portfolio select result: ${portfolioResult}`);
  await delay(2000);
  await page.screenshot({ path: 'scratch/step_4_details_filled.png' });
  
  // Click Create App
  console.log('Clicking "Create app"...');
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && e.innerText.includes('Create app'));
    if (el) el.click();
  });
  await delay(5000);
  await page.screenshot({ path: 'scratch/step_5_result.png' });
  
  // Check if password field is present now
  const modalDump = await page.evaluate(() => {
    const pwd = document.querySelector('input[type="password"]');
    const text = document.body.innerText;
    return {
      pwdFound: !!pwd,
      textPreview: text.substring(0, 500)
    };
  });
  console.log('Step 5 Result analysis:', modalDump);
  
  await browser.disconnect();
}

main().catch(console.error);
