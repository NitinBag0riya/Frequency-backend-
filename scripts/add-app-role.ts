import dotenv from 'dotenv';

dotenv.config();

const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;

async function main() {
  const userId = process.argv[2];
  const role = process.argv[3] || 'testers'; // developers, testers, administrators

  if (!userId) {
    console.error('Error: Please provide a Facebook User ID.');
    console.log('Usage: npx tsx scripts/add-app-role.ts <facebook_user_id> [role]');
    process.exit(1);
  }

  if (!APP_ID || !APP_SECRET) {
    console.error('Error: META_APP_ID or META_APP_SECRET is not set in .env');
    process.exit(1);
  }

  // An App Access Token is constructed as "APP_ID|APP_SECRET"
  const appAccessToken = `${APP_ID}|${APP_SECRET}`;
  const url = `https://graph.facebook.com/v18.0/${APP_ID}/roles`;

  console.log(`Adding Facebook User ID ${userId} to App ${APP_ID} as "${role}"...`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user: userId,
        role: role,
        access_token: appAccessToken,
      }),
    });

    const result = await response.json();

    if (response.ok && result.success) {
      console.log(`\nSuccessfully added user ${userId} as a ${role}!`);
      console.log('The user will receive an invite notification on Facebook which they must accept.');
    } else {
      console.error('\nAPI Error:', JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('Network Error:', error);
  }
}

main();
