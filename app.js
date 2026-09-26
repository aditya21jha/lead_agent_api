const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Health check
app.get("/", (req, res) => {
  res.status(200).send("WhatsApp Lead Agent API is running.");
});

// Meta webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// WhatsApp webhook events
app.post("/webhook", (req, res) => {
  console.log("WhatsApp webhook received:");
  console.log(JSON.stringify(req.body, null, 2));

  res.sendStatus(200);
});

// Send WhatsApp template message
app.post("/send", async (req, res) => {
  try {
    const { to } = req.body;

    if (!to) {
      return res.status(400).json({
        error: "Missing recipient phone number"
      });
    }

    const response = await fetch(
      `https://graph.facebook.com/v26.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: to,
          type: "template",
          template: {
            name: "hello_world",
            language: {
              code: "en_US"
            }
          }
        })
      }
    );

    const data = await response.json();

    console.log("WhatsApp API response:");
    console.log(JSON.stringify(data, null, 2));

    res.status(response.status).json(data);

  } catch (error) {
    console.error("Send message error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
