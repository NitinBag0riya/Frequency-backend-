const puppeteer = require('puppeteer');

async function main() {
  console.log('Connecting to Chrome...');
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('facebook.com') || p.url().includes('meta.com'));
  
  console.log(`Current page URL: ${page.url()}`);
  
  console.log('Entering password...');
  const result = await page.evaluate((pass) => {
    const pwdInput = document.querySelector('input[type="password"]');
    if (pwdInput) {
      pwdInput.value = pass;
      pwdInput.dispatchEvent(new Event('input', { bubbles: true }));
      pwdInput.dispatchEvent(new Event('change', { bubbles: true }));
      
      // Look for the submit button or submit form
      const btn = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
        .find(b => {
          const t = b.innerText || b.value || '';
          return t.toLowerCase().includes('submit') || t.toLowerCase().includes('confirm') || t.toLowerCase().includes('create');
        });
      if (btn) {
        btn.click();
        return 'Clicked submit button';
      } else {
        const form = pwdInput.closest('form');
        if (form) {
          form.submit();
          return 'Submitted form directly';
        }
      }
      return 'Password input found but no submit element';
    }
    return 'Password input not found';
  }, 'Facebook9@!');
  
  console.log(`Result: ${result}`);
  await new Promise(resolve => setTimeout(resolve, 5000));
  await browser.disconnect();
}

main().catch(console.error);
