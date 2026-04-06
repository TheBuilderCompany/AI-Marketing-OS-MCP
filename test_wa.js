import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const RECIPIENT = '918805679503';

async function test() {
  console.log(`Testing WhatsApp API...`);
  console.log(`Phone ID: ${PHONE_ID}`);
  console.log(`Recipient: ${RECIPIENT}`);
  
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: RECIPIENT,
        type: 'template',
        template: {
          name: 'hello_world',
          language: { code: 'en_US' }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ TEST SUCCESSFUL!');
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error('❌ TEST FAILED');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Error:', err.message);
    }
  }
}

test();
