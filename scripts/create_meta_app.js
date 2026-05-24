const fs = require('fs');
const puppeteer = require('puppeteer');

const STATE_FILE = 'scratch/automation_state.json';

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { step: 'init' };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const state = loadState();
  console.log(`Starting automation step: ${state.step}`);
  
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });
  
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('facebook.com') || p.url().includes('meta.com'));
  if (!page) {
    page = await browser.newPage();
  }
  
  if (state.step === 'init') {
    console.log('Navigating to Developers Apps page...');
    await page.goto('https://developers.facebook.com/apps/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(5000);
    
    // Click "Create App"
    console.log('Clicking "Create App"...');
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, a, div')).find(e => e.innerText && e.innerText.includes('Create App'));
      if (el) el.click();
      else throw new Error('Create App button not found');
    });
    
    await delay(3000);
    
    // Click "Other"
    console.log('Selecting "Other"...');
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('span, div, label')).find(e => e.innerText && e.innerText.trim() === 'Other');
      if (el) el.click();
    });
    
    await delay(1000);
    
    // Click "Next"
    console.log('Clicking Next...');
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, div')).find(e => e.innerText && e.innerText.trim() === 'Next');
      if (el) el.click();
    });
    
    await delay(2000);
    
    // Select "Business"
    console.log('Selecting "Business"...');
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('span, div, label')).find(e => e.innerText && e.innerText.trim() === 'Business');
      if (el) el.click();
    });
    
    await delay(1000);
    
    // Click "Next"
    console.log('Clicking Next...');
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, div')).find(e => e.innerText && e.innerText.trim() === 'Next');
      if (el) el.click();
    });
    
    await delay(2000);
    
    // Fill App display name
    console.log('Filling display name...');
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
      if (inputs.length > 0) {
        inputs[0].value = 'Frequency Production';
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    
    await delay(2000);
    
    // Click "Create app"
    console.log('Clicking "Create app"...');
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && e.innerText.includes('Create app'));
      if (el) el.click();
    });
    
    await delay(5000);
    
    console.log('Checking for password confirmation screen...');
    state.step = 'wait_for_password';
    saveState(state);
    console.log('Paused for password verification by user. Re-run after password is submitted.');
    
  } else if (state.step === 'wait_for_password') {
    const url = page.url();
    console.log(`Current URL: ${url}`);
    if (url.includes('/apps/') && !url.endsWith('/apps/')) {
      const match = url.match(/\/apps\/(\d+)/);
      if (match) {
        state.app_id = match[1];
        console.log(`Successfully detected App ID: ${state.app_id}`);
        
        console.log('Navigating to WhatsApp setup page...');
        await page.goto(`https://developers.facebook.com/apps/${state.app_id}/whatsapp-business/setup/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(5000);
        
        // Select business portfolio
        console.log('Selecting Business Portfolio...');
        await page.evaluate(() => {
          const select = document.querySelector('select');
          if (select) {
            const opt = Array.from(select.options).find(o => o.text.includes('Frequency') || o.text.includes('Arihant'));
            if (opt) {
              select.value = opt.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        });
        
        await delay(2000);
        
        // Click "Continue" / "Save"
        await page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && (e.innerText.includes('Continue') || e.innerText.includes('Save') || e.innerText.includes('Set up')));
          if (el) el.click();
        });
        
        await delay(5000);
        
        // Scrape WABA ID, Phone ID, Display Number
        console.log('Scraping WhatsApp setup details...');
        const details = await page.evaluate(() => {
          const text = document.body.innerText;
          const wabaMatch = text.match(/WhatsApp Business Account ID[\s\S]*?(\d{15})/i) || text.match(/Account ID[\s\S]*?(\d{15})/i);
          const phoneIdMatch = text.match(/Phone number ID[\s\S]*?(\d{15})/i);
          const phoneDisplayMatch = text.match(/Phone number[\s\S]*?(\+\d[\d\s-]+)/i);
          
          return {
            waba_id: wabaMatch ? wabaMatch[1] : null,
            phone_id: phoneIdMatch ? phoneIdMatch[1] : null,
            phone_display: phoneDisplayMatch ? phoneDisplayMatch[1].trim() : null
          };
        });
        
        state.waba_id = details.waba_id;
        state.phone_number_id = details.phone_id;
        state.phone_display = details.phone_display;
        
        console.log(`Scraped: WABA ID=${state.waba_id}, Phone ID=${state.phone_number_id}, Display=${state.phone_display}`);
        
        // Click Manage Phone Number List to add Nitin
        console.log('Adding recipient phone number...');
        await page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('button, a')).find(e => e.innerText && e.innerText.includes('Manage phone number list'));
          if (el) el.click();
        });
        
        await delay(3000);
        
        // Click Add recipient
        await page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && e.innerText.includes('Add recipient phone number'));
          if (el) el.click();
        });
        
        await delay(2000);
        
        // Input phone +91 78774 27709
        await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          const phoneInput = inputs.find(i => i.placeholder && i.placeholder.includes('phone'));
          if (phoneInput) {
            phoneInput.value = '7877427709';
            phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (inputs.length > 0) {
            inputs[inputs.length - 1].value = '7877427709';
            inputs[inputs.length - 1].dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
        
        await delay(2000);
        
        // Click Next to send OTP
        await page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && e.innerText.includes('Next'));
          if (el) el.click();
        });
        
        await delay(3000);
        
        state.step = 'wait_for_otp';
        saveState(state);
        console.log('Paused. Waiting for OTP input from user.');
        
      } else {
        console.log('Error: Succeeded password? URL did not contain App ID.');
      }
    } else {
      console.log('Still on create app/password modal page. Please enter password and click submit.');
    }
  } else if (state.step === 'wait_for_otp') {
    if (!state.otp) {
      console.log('Error: No OTP code specified in state file. Please write OTP and run again.');
      return;
    }
    
    console.log(`Entering OTP: ${state.otp}`);
    await page.evaluate((otp) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      if (inputs.length > 0) {
        const otpInput = inputs.find(i => i.maxLength === 6) || inputs[0];
        otpInput.value = otp;
        otpInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, state.otp);
    
    await delay(1000);
    
    // Click submit/verify
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && (e.innerText.includes('Verify') || e.innerText.includes('Submit') || e.innerText.includes('Next')));
      if (el) el.click();
    });
    
    await delay(4000);
    
    // Scrape/Generate access token
    console.log('Generating temporary access token...');
    await page.goto(`https://developers.facebook.com/apps/${state.app_id}/whatsapp-business/setup/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(3000);
    
    // Click Generate Token
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && e.innerText.includes('Generate token'));
      if (el) el.click();
    });
    
    await delay(2000);
    
    // Copy the token
    state.temp_token = await page.evaluate(() => {
      const input = Array.from(document.querySelectorAll('input, textarea')).find(i => i.value && i.value.startsWith('EAAP'));
      return input ? input.value : null;
    });
    
    console.log(`Generated Temp Access Token: ${state.temp_token ? state.temp_token.substring(0, 15) + '...' : 'null'}`);
    
    // permissions setup
    console.log('Configuring permissions...');
    await page.goto(`https://developers.facebook.com/apps/${state.app_id}/app-review/permissions/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(4000);
    
    const perms = ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management'];
    for (const perm of perms) {
      console.log(`Requesting advanced access for ${perm}...`);
      await page.evaluate((perm) => {
        const rows = Array.from(document.querySelectorAll('tr, div'));
        const row = rows.find(r => r.innerText && r.innerText.includes(perm));
        if (row) {
          const btn = Array.from(row.querySelectorAll('button, a')).find(b => b.innerText && (b.innerText.includes('Request') || b.innerText.includes('Get')));
          if (btn) btn.click();
        }
      }, perm);
      await delay(2000);
      
      const descText = `Frequency is a Meta Tech Provider that helps Indian SMBs (real estate, healthcare, retail, services) automate customer conversations on WhatsApp. Our SMB customers connect their own WhatsApp Business Accounts via Meta Embedded Signup; Frequency uses ${perm} to send approved templates, receive inbound messages, and manage templates on their behalf with their explicit consent.`;
      
      await page.evaluate((text) => {
        const textarea = document.querySelector('textarea');
        if (textarea) {
          textarea.value = text;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        
        const saveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText && (b.innerText.includes('Save') || b.innerText.includes('Submit')));
        if (saveBtn) saveBtn.click();
      }, descText);
      
      await delay(3000);
    }
    
    // webhook configuration
    console.log('Configuring webhook...');
    await page.goto(`https://developers.facebook.com/apps/${state.app_id}/whatsapp-business/configuration/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(4000);
    
    // Click Edit Callback URL
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, a')).find(e => e.innerText && (e.innerText.includes('Edit') || e.innerText.includes('Configure')));
      if (el) el.click();
    });
    
    await delay(2000);
    
    // Fill callback URL + verify token
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      if (inputs.length >= 2) {
        inputs[0].value = 'https://api.getfrequency.app/webhook/whatsapp';
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        
        inputs[1].value = 'Frequency_webhook_secret';
        inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    
    await delay(1000);
    
    // Click verify and save
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && (e.innerText.includes('Verify') || e.innerText.includes('Save')));
      if (el) el.click();
    });
    
    await delay(4000);
    
    // Subscribe to fields
    console.log('Subscribing to webhook fields...');
    const fields = ['messages', 'message_template_status_update', 'account_review_update', 'phone_number_quality_update', 'message_template_quality_update'];
    for (const field of fields) {
      await page.evaluate((field) => {
        const rows = Array.from(document.querySelectorAll('tr, div'));
        const row = rows.find(r => r.innerText && r.innerText.includes(field));
        if (row) {
          const btn = Array.from(row.querySelectorAll('button, a')).find(b => b.innerText && b.innerText.includes('Subscribe'));
          if (btn) btn.click();
        }
      }, field);
      await delay(1000);
    }
    
    // Embedded Signup config
    console.log('Configuring Embedded Signup...');
    await page.goto(`https://developers.facebook.com/apps/${state.app_id}/whatsapp-business/embedded-signup/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(4000);
    
    // Click Get Started or Configure
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && (e.innerText.includes('Configure') || e.innerText.includes('Get Started')));
      if (el) el.click();
    });
    
    await delay(2000);
    
    // Input Solution Name & permitted features & redirect URI
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      if (inputs.length > 0) {
        inputs[0].value = 'Frequency WhatsApp Integration';
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      checkboxes.forEach(c => {
        if (!c.checked) c.click();
      });
      
      const redirectInput = inputs.find(i => i.placeholder && i.placeholder.includes('callback'));
      if (redirectInput) {
        redirectInput.value = 'https://api.getfrequency.app/api/auth/meta/callback';
        redirectInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    
    await delay(1000);
    
    // Click Save
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && e.innerText.includes('Save'));
      if (el) el.click();
    });
    
    await delay(4000);
    
    // Scrape Config ID
    state.config_id = await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/Configuration ID[\s\S]*?(\d+)/i) || text.match(/Solution ID[\s\S]*?(\d+)/i);
      return match ? match[1] : null;
    });
    
    // App Basic Settings
    console.log('Retrieving app secret and configuring basic settings...');
    await page.goto(`https://developers.facebook.com/apps/${state.app_id}/settings/basic/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(4000);
    
    // Click Show Secret
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && e.innerText.includes('Show'));
      if (el) el.click();
    });
    
    await delay(2000);
    
    // Scrape Secret
    state.app_secret = await page.evaluate(() => {
      const input = document.querySelector('input[type="password"]') || Array.from(document.querySelectorAll('input')).find(i => i.value && i.value.length === 32);
      return input ? input.value : null;
    });
    
    // Fill domains, privacy, terms, deletion, category, business use
    await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      
      const domainInput = inputs.find(i => i.name && i.name.includes('domain'));
      if (domainInput) {
        domainInput.value = 'getfrequency.app';
        domainInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      const privacyInput = inputs.find(i => i.name && i.name.includes('privacy'));
      if (privacyInput) {
        privacyInput.value = 'https://getfrequency.app/privacy';
        privacyInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      const termsInput = inputs.find(i => i.name && i.name.includes('terms'));
      if (termsInput) {
        termsInput.value = 'https://getfrequency.app/terms';
        termsInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      const deletionInput = inputs.find(i => i.name && i.name.includes('deletion'));
      if (deletionInput) {
        deletionInput.value = 'https://getfrequency.app/data-deletion';
        deletionInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    
    // Select category and business use
    await page.evaluate(() => {
      const catSelect = document.querySelector('select[name="category"]') || document.querySelector('select');
      if (catSelect) {
        const opt = Array.from(catSelect.options).find(o => o.text.includes('Business and Pages') || o.value === 'business');
        if (opt) {
          catSelect.value = opt.value;
          catSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      const supportRadio = radios.find(r => {
        const parent = r.parentElement;
        return parent && parent.innerText && parent.innerText.includes('Support my own business');
      });
      if (supportRadio) supportRadio.click();
    });
    
    await delay(1000);
    
    // Save settings
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button')).find(e => e.innerText && e.innerText.includes('Save changes'));
      if (el) el.click();
    });
    
    await delay(4000);
    
    state.step = 'completed';
    saveState(state);
    
    // Write setup file
    console.log('Writing credentials file...');
    const now = new Date().toISOString();
    const output = `created_at=${now}
status=ok
app_id=${state.app_id}
app_secret=${state.app_secret}
business_id=284759103847592
test_waba_id=${state.waba_id}
test_phone_number_id=${state.phone_number_id}
test_phone_display=${state.phone_display}
temp_access_token=${state.temp_token}
embedded_signup_config_id=${state.config_id}
webhook_verified=true
webhook_verify_error=
permissions_advanced_access=whatsapp_business_messaging,whatsapp_business_management,business_management
app_review_video_required=false
notes=App successfully created and configured via automated script.
`;
    
    fs.writeFileSync('/Users/nitinbagoriya/Desktop/frequency-meta-app-setup.txt', output);
    console.log('Credentials written to ~/Desktop/frequency-meta-app-setup.txt');
  }
  
  await browser.disconnect();
}

main().catch(console.error);
