const TOKEN = "EAAM7HgH6VvwBRE0ZCr2DxOjeQyVP6KiyVN93kaDasQiVKrwaTId1nFE0v8Sz3Y5VAQGvEGUGSzDNBXtTQeEgdMSKcOXxTdcjpqtW8GW8jq69hUZCmBNN1BLDiTNmrxQO4yjOLE4n8n3ZBZCCj76ieHYrg7rdYWtHlHHZBCZAlxWTN0MKYZArqB78kGtzO8pngZDZD"
const WABA_ID = "721735523894042"

const templates = [
  {
    name: "lead_welcome_bhk",
    text: "Welcome to Arihant Dream Infra Projects! To better assist you, please let us know what kind of property you are looking for:",
    buttons: ["1 BHK", "2 BHK", "3 BHK"]
  },
  {
    name: "lead_budget_1bhk",
    text: "Great choice! A 1 BHK is perfect for starters. What is your approximate budget?",
    buttons: ["Up to Rs. 25 Lakh", "Rs. 25-30 Lakh", "Above Rs. 30 Lakh"]
  },
  {
    name: "lead_budget_2bhk",
    text: "Excellent! We have beautiful 2 BHK options. What is your approximate budget?",
    buttons: ["Up to Rs. 45 Lakh", "Rs. 45-55 Lakh", "Above Rs. 55 Lakh"]
  },
  {
    name: "lead_budget_3bhk",
    text: "Wonderful! For our spacious 3 BHK apartments, what is your budget range?",
    buttons: ["Up to Rs. 60 Lakh", "Rs. 60-70 Lakh", "Above Rs. 70 Lakh"]
  },
  {
    name: "lead_action_options",
    text: "Thank you for sharing your requirements. We have some great options for you. What would you like to do next?",
    buttons: ["Get Brochure", "Schedule a Visit", "Request a Call"]
  }
]

async function createTemplate(template) {
  const url = `https://graph.facebook.com/v18.0/${WABA_ID}/message_templates`
  const payload = {
    name: template.name,
    language: "en_US",
    category: "MARKETING",
    components: [
      { type: "BODY", text: template.text },
      {
        type: "BUTTONS",
        buttons: template.buttons.map(btn => ({ type: "QUICK_REPLY", text: btn }))
      }
    ]
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await res.json()
  if (data.error) {
    console.log(`❌ ${template.name}: ${data.error.message} (code ${data.error.code})`)
  } else {
    console.log(`✅ ${template.name}: ID ${data.id}`)
  }
  return data
}

async function fetchTemplates() {
  const url = `https://graph.facebook.com/v18.0/${WABA_ID}/message_templates?fields=id,name,status,category,language,components&limit=20`
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${TOKEN}` } })
  return res.json()
}

async function run() {
  console.log("\n📤 Creating templates...\n")
  for (const t of templates) {
    await createTemplate(t)
    await new Promise(r => setTimeout(r, 500)) // avoid rate limiting
  }

  console.log("\n📋 Fetching all templates from WABA...\n")
  const result = await fetchTemplates()
  if (result.data) {
    console.log(JSON.stringify(result.data, null, 2))
    console.log(`\nTotal templates: ${result.data.length}`)
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
}

run()
