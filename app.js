const express = require("express");
const path = require("path");
const fs = require("fs");
const {
  getCountries,
  getCountryCallingCode
} = require("libphonenumber-js");

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WABA_ID = process.env.WABA_ID;
const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

const GRAPH_API_VERSION =
  process.env.GRAPH_API_VERSION || "v23.0";

const GRAPH_URL =
  `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/*
|--------------------------------------------------------------------------
| Simple local data store
|--------------------------------------------------------------------------
|
| This keeps the application immediately functional.
| For permanent production storage, connect these collections to
| PostgreSQL/Supabase/another database later.
|
*/

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "database.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const defaultDatabase = {
  contacts: [],
  lists: [],
  conversations: {},
  messages: [],
  campaigns: [],
  templates: [],
  events: []
};

function loadDatabase() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(defaultDatabase, null, 2)
      );

      return structuredClone(defaultDatabase);
    }

    const data = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    return {
      ...structuredClone(defaultDatabase),
      ...data
    };
  } catch (error) {
    console.error("Database load error:", error);
    return structuredClone(defaultDatabase);
  }
}

let db = loadDatabase();

function saveDatabase() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(db, null, 2)
    );
  } catch (error) {
    console.error("Database save error:", error);
  }
}

/*
|--------------------------------------------------------------------------
| Utilities
|--------------------------------------------------------------------------
*/

function now() {
  return new Date().toISOString();
}

function cleanPhone(value) {
  return String(value || "")
    .replace(/\D/g, "");
}

function makeId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function addEvent(type, data = {}) {
  db.events.unshift({
    id: makeId("event"),
    type,
    timestamp: now(),
    data
  });

  db.events = db.events.slice(0, 500);

  saveDatabase();
}

function getContact(phone) {
  const normalized = cleanPhone(phone);

  return db.contacts.find(
    c =>
      cleanPhone(c.wa_id || c.phone) === normalized
  );
}

function upsertContact(contactData) {
  const phone =
    cleanPhone(contactData.wa_id) ||
    cleanPhone(contactData.phone);

  if (!phone) return null;

  let contact = getContact(phone);

  if (!contact) {
    contact = {
      id: makeId("contact"),
      name:
        contactData.name ||
        contactData.profileName ||
        "WhatsApp Contact",
      countryCode: contactData.countryCode || "",
      phone: phone,
      wa_id: phone,
      tags: [],
      lists: [],
      createdAt: now(),
      updatedAt: now()
    };

    db.contacts.push(contact);
  } else {
    if (contactData.name) {
      contact.name = contactData.name;
    }

    contact.updatedAt = now();
  }

  saveDatabase();

  return contact;
}

function getConversation(phone) {
  const normalized = cleanPhone(phone);

  if (!db.conversations[normalized]) {
    db.conversations[normalized] = {
      wa_id: normalized,
      unread: 0,
      lastIncomingAt: null,
      lastMessageAt: null,
      lastMessage: "",
      lastDirection: null
    };
  }

  return db.conversations[normalized];
}

/*
|--------------------------------------------------------------------------
| Meta API
|--------------------------------------------------------------------------
*/

async function metaRequest(endpoint, options = {}) {
  if (!WHATSAPP_TOKEN) {
    throw new Error("WHATSAPP_TOKEN is not configured.");
  }

  const response = await fetch(
    `${GRAPH_URL}${endpoint}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
      data?.message ||
      "Meta API request failed"
    );

    error.status = response.status;
    error.meta = data;

    throw error;
  }

  return data;
}

/*
|--------------------------------------------------------------------------
| Health / configuration
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Royal Hair Istanbul WhatsApp Dashboard",
    timestamp: now(),
    whatsappConfigured: Boolean(
      WHATSAPP_TOKEN &&
      PHONE_NUMBER_ID &&
      WABA_ID
    )
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    configured: Boolean(
      WHATSAPP_TOKEN &&
      PHONE_NUMBER_ID &&
      WABA_ID
    ),
    phoneNumberId: PHONE_NUMBER_ID || "",
    wabaId: WABA_ID || "",
    graphApiVersion: GRAPH_API_VERSION
  });
});

/*
|--------------------------------------------------------------------------
| Bitrix24 connection test
|--------------------------------------------------------------------------
*/
app.get("/api/bitrix/test", async (req, res) => {
  try {
    if (!BITRIX_WEBHOOK_URL) {
      return res.status(500).json({
        ok: false,
        error: "BITRIX_WEBHOOK_URL is not configured"
      });
    }

    const baseUrl = BITRIX_WEBHOOK_URL.endsWith("/")
      ? BITRIX_WEBHOOK_URL
      : `${BITRIX_WEBHOOK_URL}/`;

    const response = await fetch(`${baseUrl}profile.json`);
    const data = await response.json();

    if (!response.ok || data.error) {
      return res.status(500).json({
        ok: false,
        error:
          data?.error_description ||
          data?.error ||
          "Bitrix API request failed"
      });
    }

    return res.json({
      ok: true,
      message: "Bitrix connection successful",
      user: data.result || null
    });
  } catch (error) {
    console.error("Bitrix test error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Bitrix connection failed"
    });
  }
});

/*
|--------------------------------------------------------------------------
| Country codes
|--------------------------------------------------------------------------
*/

app.get("/api/countries", (req, res) => {
  const displayNames = new Intl.DisplayNames(
    ["en"],
    {
      type: "region"
    }
  );

  const countries = getCountries()
    .map(country => ({
      iso: country,
      name:
        displayNames.of(country) ||
        country,
      callingCode:
        getCountryCallingCode(country)
    }))
    .filter(c => c.callingCode)
    .sort((a, b) =>
      a.name.localeCompare(b.name)
    );

  res.json({
    data: countries
  });
});

/*
|--------------------------------------------------------------------------
| WhatsApp send helpers
|--------------------------------------------------------------------------
*/

async function sendTextMessage(to, body) {
  const recipient = cleanPhone(to);

  if (!recipient) {
    throw new Error("Invalid recipient number.");
  }

  if (!body || !String(body).trim()) {
    throw new Error("Message text is required.");
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "text",
    text: {
      preview_url: false,
      body: String(body)
    }
  };

  const result = await metaRequest(
    `/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );

  const messageId =
    result?.messages?.[0]?.id || null;

  storeOutboundMessage({
    to: recipient,
    messageId,
    type: "text",
    text: body,
    metaResponse: result
  });

  return result;
}

async function sendTemplateMessage({
  to,
  name,
  language,
  components = []
}) {
  const recipient = cleanPhone(to);

  if (!recipient) {
    throw new Error("Invalid recipient number.");
  }

  if (!name) {
    throw new Error("Template name is required.");
  }

  if (!language) {
    throw new Error("Template language is required.");
  }

  const template = {
    name,
    language: {
      code: language
    }
  };

  if (
    Array.isArray(components) &&
    components.length
  ) {
    template.components = components;
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "template",
    template
  };

  const result = await metaRequest(
    `/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );

  const messageId =
    result?.messages?.[0]?.id || null;

  storeOutboundMessage({
    to: recipient,
    messageId,
    type: "template",
    templateName: name,
    templateLanguage: language,
    templateComponents: components,
    metaResponse: result
  });

  return result;
}

function storeOutboundMessage({
  to,
  messageId,
  type,
  text,
  templateName,
  templateLanguage,
  templateComponents,
  metaResponse
}) {
  const phone = cleanPhone(to);

  upsertContact({
    phone,
    wa_id: phone
  });

  const conversation =
    getConversation(phone);

  const message = {
    id: makeId("msg"),
    wamid: messageId,
    wa_id: phone,
    direction: "outbound",
    type,
    text: text || "",
    templateName: templateName || null,
    templateLanguage:
      templateLanguage || null,
    templateComponents:
      templateComponents || [],
    status: "accepted",
    timestamp: now(),
    metaResponse
  };

  db.messages.push(message);

  conversation.lastMessage =
    text ||
    `Template: ${templateName || ""}`;

  conversation.lastMessageAt =
    message.timestamp;

  conversation.lastDirection =
    "outbound";

  saveDatabase();

  return message;
}

/*
|--------------------------------------------------------------------------
| Backwards-compatible /send endpoint
|--------------------------------------------------------------------------
*/

app.post("/send", async (req, res) => {
  try {
    const {
      to,
      message,
      text,
      template,
      templateName,
      language,
      components
    } = req.body || {};

    if (template || templateName) {
      const result =
        await sendTemplateMessage({
          to,
          name:
            templateName ||
            template?.name,
          language:
            language ||
            template?.language?.code ||
            "en_US",
          components:
            components ||
            template?.components ||
            []
        });

      return res.json(result);
    }

    const result =
      await sendTextMessage(
        to,
        message || text ||
        "Hello from Royal Hair Istanbul."
      );

    return res.json(result);
  } catch (error) {
    console.error(
      "Send message error:",
      error
    );

    res.status(
      error.status || 500
    ).json({
      error:
        error.message ||
        "Unable to send message",
      meta:
        error.meta || null
    });
  }
});

/*
|--------------------------------------------------------------------------
| Single message API
|--------------------------------------------------------------------------
*/

app.post("/api/messages/send", async (req, res) => {
  try {
    const {
      to,
      type,
      text,
      template
    } = req.body || {};

    let result;

    if (type === "template") {
      result =
        await sendTemplateMessage({
          to,
          name: template?.name,
          language:
            template?.language,
          components:
            template?.components || []
        });
    } else {
      result =
        await sendTextMessage(
          to,
          text
        );
    }

    addEvent(
      "message_sent",
      {
        to: cleanPhone(to),
        type
      }
    );

    res.json({
      success: true,
      result
    });
  } catch (error) {
    res.status(
      error.status || 500
    ).json({
      success: false,
      error: error.message,
      meta: error.meta || null
    });
  }
});

/*
|--------------------------------------------------------------------------
| Templates - Sync from Meta
|--------------------------------------------------------------------------
*/

async function fetchAllTemplates() {
  if (!WABA_ID) {
    throw new Error(
      "WABA_ID is not configured."
    );
  }

  let url =
    `/${WABA_ID}/message_templates` +
    `?fields=id,name,status,category,language,components,quality_score` +
    `&limit=100`;

  const all = [];

  let pages = 0;

  while (url && pages < 20) {
    const data =
      await metaRequest(url);

    if (Array.isArray(data.data)) {
      all.push(...data.data);
    }

    url =
      data?.paging?.next
        ? data.paging.next.replace(
            GRAPH_URL,
            ""
          )
        : null;

    pages++;
  }

  db.templates = all;
  saveDatabase();

  addEvent(
    "templates_synced",
    {
      count: all.length
    }
  );

  return all;
}

app.get("/api/templates", async (req, res) => {
  try {
    const templates =
      await fetchAllTemplates();

    res.json({
      success: true,
      data: templates
    });
  } catch (error) {
    res.status(
      error.status || 500
    ).json({
      success: false,
      error: error.message,
      meta: error.meta || null,
      cached: db.templates
    });
  }
});

app.post(
  "/api/templates/sync",
  async (req, res) => {
    try {
      const templates =
        await fetchAllTemplates();

      res.json({
        success: true,
        count: templates.length,
        data: templates
      });
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        success: false,
        error: error.message,
        meta: error.meta || null
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Contacts
|--------------------------------------------------------------------------
*/

app.get("/api/contacts", (req, res) => {
  res.json({
    data: db.contacts
  });
});

app.post(
  "/api/contacts/import",
  (req, res) => {
    try {
      const contacts =
        Array.isArray(req.body?.contacts)
          ? req.body.contacts
          : [];

      let imported = 0;
      let updated = 0;

      contacts.forEach(item => {
        const phone =
          cleanPhone(
            item.phone ||
            item.number ||
            item.wa_id
          );

        if (!phone) return;

        const existing =
          getContact(phone);

        const contact =
          upsertContact({
            ...item,
            phone,
            wa_id: phone
          });

        if (existing) {
          updated++;
        } else if (contact) {
          imported++;
        }

        if (
          item.listId &&
          contact
        ) {
          addContactToList(
            contact.id,
            item.listId
          );
        }
      });

      saveDatabase();

      res.json({
        success: true,
        imported,
        updated,
        total: imported + updated
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Lists
|--------------------------------------------------------------------------
*/

app.get("/api/lists", (req, res) => {
  const lists =
    db.lists.map(list => ({
      ...list,
      contactCount:
        list.contactIds.length
    }));

  res.json({
    data: lists
  });
});

app.post("/api/lists", (req, res) => {
  const name =
    String(
      req.body?.name || ""
    ).trim();

  if (!name) {
    return res.status(400).json({
      error: "List name is required."
    });
  }

  const list = {
    id: makeId("list"),
    name,
    contactIds: [],
    createdAt: now()
  };

  db.lists.push(list);

  saveDatabase();

  res.json({
    success: true,
    data: list
  });
});

function addContactToList(
  contactId,
  listId
) {
  const list =
    db.lists.find(
      l => l.id === listId
    );

  const contact =
    db.contacts.find(
      c => c.id === contactId
    );

  if (!list || !contact) {
    return false;
  }

  if (
    !list.contactIds.includes(
      contactId
    )
  ) {
    list.contactIds.push(
      contactId
    );
  }

  if (
    !contact.lists.includes(
      listId
    )
  ) {
    contact.lists.push(
      listId
    );
  }

  return true;
}

app.post(
  "/api/lists/:listId/contacts",
  (req, res) => {
    const listId =
      req.params.listId;

    const contactIds =
      Array.isArray(
        req.body?.contactIds
      )
        ? req.body.contactIds
        : [];

    let added = 0;

    contactIds.forEach(
      contactId => {
        if (
          addContactToList(
            contactId,
            listId
          )
        ) {
          added++;
        }
      }
    );

    saveDatabase();

    res.json({
      success: true,
      added
    });
  }
);

app.delete(
  "/api/lists/:listId/contacts/:contactId",
  (req, res) => {
    const list =
      db.lists.find(
        l =>
          l.id ===
          req.params.listId
      );

    const contact =
      db.contacts.find(
        c =>
          c.id ===
          req.params.contactId
      );

    if (!list || !contact) {
      return res.status(404).json({
        error: "Contact or list not found."
      });
    }

    list.contactIds =
      list.contactIds.filter(
        id =>
          id !==
          contact.id
      );

    contact.lists =
      contact.lists.filter(
        id =>
          id !==
          list.id
      );

    saveDatabase();

    res.json({
      success: true
    });
  }
);

/*
|--------------------------------------------------------------------------
| Campaigns
|--------------------------------------------------------------------------
*/

app.get("/api/campaigns", (req, res) => {
  res.json({
    data: db.campaigns
  });
});

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

app.post(
  "/api/campaigns",
  async (req, res) => {
    try {
      const {
        name,
        listId,
        contactIds,
        template,
        delayMs
      } = req.body || {};

      if (!template?.name) {
        return res.status(400).json({
          error:
            "An approved Meta template is required."
        });
      }

      let recipients = [];

      if (listId) {
        const list =
          db.lists.find(
            l =>
              l.id === listId
          );

        if (!list) {
          return res.status(404).json({
            error:
              "Contact list not found."
          });
        }

        recipients =
          db.contacts.filter(
            c =>
              list.contactIds.includes(
                c.id
              )
          );
      } else if (
        Array.isArray(contactIds)
      ) {
        recipients =
          db.contacts.filter(
            c =>
              contactIds.includes(
                c.id
              )
          );
      }

      if (!recipients.length) {
        return res.status(400).json({
          error:
            "No contacts selected."
        });
      }

      const campaign = {
        id: makeId("campaign"),
        name:
          name ||
          `Campaign ${new Date().toLocaleString()}`,
        listId:
          listId || null,
        template,
        status: "running",
        createdAt: now(),
        total: recipients.length,
        sent: 0,
        failed: 0,
        delivered: 0,
        read: 0,
        results: []
      };

      db.campaigns.unshift(
        campaign
      );

      saveDatabase();

      res.json({
        success: true,
        campaignId:
          campaign.id,
        total:
          recipients.length
      });

      /*
       * Run after HTTP response.
       */
      (async () => {
        for (
          const contact of recipients
        ) {
          try {
            const variables =
              Array.isArray(
                contact.variables
              )
                ? contact.variables
                : [];

            const components =
              buildTemplateComponents(
                template.components || [],
                variables
              );

            const result =
              await sendTemplateMessage({
                to:
                  contact.wa_id ||
                  contact.phone,
                name:
                  template.name,
                language:
                  template.language,
                components
              });

            campaign.sent++;

            campaign.results.push({
              contactId:
                contact.id,
              phone:
                contact.wa_id ||
                contact.phone,
              status:
                "accepted",
              messageId:
                result?.messages?.[0]?.id ||
                null,
              timestamp: now()
            });
          } catch (error) {
            campaign.failed++;

            campaign.results.push({
              contactId:
                contact.id,
              phone:
                contact.wa_id ||
                contact.phone,
              status:
                "failed",
              error:
                error.message,
              timestamp: now()
            });
          }

          saveDatabase();

          await sleep(
            Math.max(
              300,
              Number(delayMs) || 700
            )
          );
        }

        campaign.status =
          "completed";

        campaign.completedAt =
          now();

        saveDatabase();

        addEvent(
          "campaign_completed",
          {
            campaignId:
              campaign.id
          }
        );
      })();
    } catch (error) {
      console.error(
        "Campaign error:",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error:
            error.message
        });
      }
    }
  }
);

function buildTemplateComponents(
  templateComponents,
  variables
) {
  if (
    !Array.isArray(
      templateComponents
    )
  ) {
    return [];
  }

  let variableIndex = 0;

  return templateComponents
    .map(component => {
      const componentText =
        component.text || "";

      const matches =
        componentText.match(
          /\{\{\d+\}\}/g
        ) || [];

      if (
        component.type !== "BODY" &&
        component.type !== "HEADER"
      ) {
        return null;
      }

      if (!matches.length) {
        return null;
      }

      const parameters =
        matches.map(() => ({
          type: "text",
          text:
            String(
              variables[
                variableIndex++
              ] ?? ""
            )
        }));

      return {
        type:
          String(
            component.type
          ).toLowerCase(),
        parameters
      };
    })
    .filter(Boolean);
}

/*
|--------------------------------------------------------------------------
| Inbox
|--------------------------------------------------------------------------
*/

app.get("/api/inbox", (req, res) => {
  const conversations =
    Object.values(
      db.conversations
    )
      .map(conversation => {
        const contact =
          getContact(
            conversation.wa_id
          );

        return {
          ...conversation,
          contact
        };
      })
      .sort(
        (a, b) =>
          new Date(
            b.lastMessageAt || 0
          ) -
          new Date(
            a.lastMessageAt || 0
          )
      );

  res.json({
    data: conversations
  });
});

app.get(
  "/api/inbox/:waId/messages",
  (req, res) => {
    const phone =
      cleanPhone(
        req.params.waId
      );

    const messages =
      db.messages.filter(
        m =>
          cleanPhone(
            m.wa_id
          ) === phone
      );

    res.json({
      data: messages
    });
  }
);

app.post(
  "/api/inbox/:waId/send",
  async (req, res) => {
    try {
      const phone =
        cleanPhone(
          req.params.waId
        );

      const {
        type,
        text,
        template
      } = req.body || {};

      let result;

      if (
        type === "template"
      ) {
        result =
          await sendTemplateMessage({
            to: phone,
            name:
              template?.name,
            language:
              template?.language,
            components:
              template?.components ||
              []
          });
      } else {
        result =
          await sendTextMessage(
            phone,
            text
          );
      }

      res.json({
        success: true,
        result
      });
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        success: false,
        error: error.message,
        meta: error.meta || null
      });
    }
  }
);

app.post(
  "/api/inbox/:waId/read",
  (req, res) => {
    const conversation =
      db.conversations[
        cleanPhone(
          req.params.waId
        )
      ];

    if (conversation) {
      conversation.unread = 0;
    }

    saveDatabase();

    res.json({
      success: true
    });
  }
);

/*
|--------------------------------------------------------------------------
| Webhook verification
|--------------------------------------------------------------------------
*/

app.get("/webhook", (req, res) => {
  const mode =
    req.query["hub.mode"];

  const token =
    req.query["hub.verify_token"];

  const challenge =
    req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {
    console.log(
      "WEBHOOK VERIFIED"
    );

    return res
      .status(200)
      .send(challenge);
  }

  return res.sendStatus(403);
});

/*
|--------------------------------------------------------------------------
| WhatsApp webhook
|--------------------------------------------------------------------------
*/

app.post("/webhook", (req, res) => {
  /*
   * Respond immediately so Meta knows
   * the webhook was received.
   */
  res.sendStatus(200);

  try {
    const body = req.body;

    if (
      body?.object !==
      "whatsapp_business_account"
    ) {
      return;
    }

    const entries =
      body.entry || [];

    entries.forEach(entry => {
      const changes =
        entry.changes || [];

      changes.forEach(change => {
        const value =
          change.value || {};

        /*
        |--------------------------------------------------------------------------
        | Incoming messages
        |--------------------------------------------------------------------------
        */

        if (
          Array.isArray(
            value.messages
          )
        ) {
          value.messages.forEach(
            message => {
              handleIncomingMessage(
                message,
                value
              );
            }
          );
        }

        /*
        |--------------------------------------------------------------------------
        | Message status updates
        |--------------------------------------------------------------------------
        */

        if (
          Array.isArray(
            value.statuses
          )
        ) {
          value.statuses.forEach(
            status => {
              handleStatusUpdate(
                status
              );
            }
          );
        }
      });
    });
  } catch (error) {
    console.error(
      "Webhook processing error:",
      error
    );
  }
});

function handleIncomingMessage(
  message,
  value
) {
  const phone =
    cleanPhone(
      message.from
    );

  if (!phone) return;

  const profileName =
    value?.contacts?.find(
      c =>
        cleanPhone(
          c.wa_id
        ) === phone
    )?.profile?.name;

  upsertContact({
    phone,
    wa_id: phone,
    name:
      profileName ||
      "WhatsApp Contact"
  });

  const conversation =
    getConversation(phone);

  let text = "";

  if (
    message.type ===
    "text"
  ) {
    text =
      message.text?.body ||
      "";
  } else if (
    message.type ===
    "button"
  ) {
    text =
      message.button?.text ||
      "";
  } else if (
    message.type ===
    "interactive"
  ) {
    text =
      message.interactive
        ?.button_reply?.title ||
      message.interactive
        ?.list_reply?.title ||
      "";
  } else {
    text =
      `[${message.type || "message"}]`;
  }

  const timestamp =
    message.timestamp
      ? new Date(
          Number(
            message.timestamp
          ) * 1000
        ).toISOString()
      : now();

  const storedMessage = {
    id: makeId("msg"),
    wamid: message.id,
    wa_id: phone,
    direction: "inbound",
    type:
      message.type ||
      "unknown",
    text,
    raw: message,
    status: "received",
    timestamp
  };

  db.messages.push(
    storedMessage
  );

  conversation.unread =
    Number(
      conversation.unread || 0
    ) + 1;

  conversation.lastIncomingAt =
    timestamp;

  conversation.lastMessageAt =
    timestamp;

  conversation.lastMessage =
    text;

  conversation.lastDirection =
    "inbound";

  saveDatabase();

  addEvent(
    "incoming_message",
    {
      wa_id: phone,
      type:
        message.type
    }
  );
}

function handleStatusUpdate(
  status
) {
  const message =
    db.messages.find(
      m =>
        m.wamid ===
        status.id
    );

  if (message) {
    message.status =
      status.status;

    message.statusTimestamp =
      status.timestamp
        ? new Date(
            Number(
              status.timestamp
            ) * 1000
          ).toISOString()
        : now();

    message.statusErrors =
      status.errors || [];
  }

  /*
   * Update campaign statistics.
   */
  db.campaigns.forEach(
    campaign => {
      const result =
        campaign.results.find(
          r =>
            r.messageId ===
            status.id
        );

      if (result) {
        result.status =
          status.status;

        if (
          status.status ===
          "delivered"
        ) {
          campaign.delivered++;
        }

        if (
          status.status ===
          "read"
        ) {
          campaign.read++;
        }

        if (
          status.status ===
          "failed"
        ) {
          result.error =
            status.errors ||
            [];
        }
      }
    }
  );

  saveDatabase();

  addEvent(
    "message_status",
    {
      wamid: status.id,
      status:
        status.status,
      recipient:
        status.recipient_id
    }
  );
}

/*
|--------------------------------------------------------------------------
| Recent activity
|--------------------------------------------------------------------------
*/

app.get("/api/events", (req, res) => {
  res.json({
    data:
      db.events.slice(
        0,
        100
      )
  });
});

/*
|--------------------------------------------------------------------------
| Dashboard statistics
|--------------------------------------------------------------------------
*/

app.get(
  "/api/dashboard/stats",
  (req, res) => {
    const totalContacts =
      db.contacts.length;

    const totalMessages =
      db.messages.length;

    const inbound =
      db.messages.filter(
        m =>
          m.direction ===
          "inbound"
      ).length;

    const outbound =
      db.messages.filter(
        m =>
          m.direction ===
          "outbound"
      ).length;

    const unread =
      Object.values(
        db.conversations
      ).reduce(
        (sum, c) =>
          sum +
          Number(
            c.unread || 0
          ),
        0
      );

    const activeCampaigns =
      db.campaigns.filter(
        c =>
          c.status ===
          "running"
      ).length;

    res.json({
      totalContacts,
      totalMessages,
      inbound,
      outbound,
      unread,
      activeCampaigns,
      templates:
        db.templates.length,
      lists:
        db.lists.length
    });
  }
);

/*
|--------------------------------------------------------------------------
| Root
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Royal Hair WhatsApp Dashboard running on port ${PORT}`
    );
  }
);
