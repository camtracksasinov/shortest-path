const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios = require('axios');
require('dotenv').config();

const CLIENT_ID    = process.env.GRAPH_CLIENT_ID;
const TENANT_ID    = process.env.GRAPH_TENANT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const SENDER_EMAIL = process.env.EMAIL_USER;

const msalApp = new ConfidentialClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    clientSecret: CLIENT_SECRET
  }
});

async function getAccessToken() {
  const result = await msalApp.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default']
  });
  return result.accessToken;
}

async function sendMail({ to, subject, html }) {
  const token = await getAccessToken();
  const recipients = (Array.isArray(to) ? to : to.split(';'))
    .map(e => e.trim()).filter(Boolean)
    .map(address => ({ emailAddress: { address } }));

  await axios.post(
    `https://graph.microsoft.com/v1.0/users/${SENDER_EMAIL}/sendMail`,
    {
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: recipients
      }
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

module.exports = { sendMail };
