
const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const {
  getCountries,
  getCountryCallingCode
} = require("libphonenumber-js");

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  if (!appReady && !req.path.startsWith("/webhook")) return res.status(503).json({ ok: false, error: "Application is starting. Please retry in a moment." });
  next();
});

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WABA_ID = process.env.WABA_ID;
const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v23.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "database.json");
const DATABASE_URL = process.env.DATABASE_URL || "";
const DB_PERSIST_DEBOUNCE_MS = Math.max(250, Number(process.env.DB_PERSIST_DEBOUNCE_MS || 750));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const pgPool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

const DB_STATE_ID = "royal_hair_main";
let dbSaveTimer = null;
let dbSaveInFlight = null;
let dbSaveQueued = false;
let appReady = false;
let db;


const STAGES = {
  CONTACTED: "Contacted",
  PENDING_FOLLOWUP: "Pending for Follow-up",
  FOLLOWUP_DONE: "Follow-up Done",
  WAITING_RESPONSE: "Waiting for Response",
  PHOTO_RECEIVED: "Photo Received",
  JUNK: "Junk"
};

const STAGE_META = {
  [STAGES.CONTACTED]: { color: "#3b82f6", tone: "blue" },
  [STAGES.PENDING_FOLLOWUP]: { color: "#f59e0b", tone: "orange" },
  [STAGES.FOLLOWUP_DONE]: { color: "#8b5cf6", tone: "purple" },
  [STAGES.WAITING_RESPONSE]: { color: "#10b981", tone: "green" },
  [STAGES.PHOTO_RECEIVED]: { color: "#0f9aa8", tone: "teal" },
  [STAGES.JUNK]: { color: "#dc3545", tone: "red" }
};

const defaultDatabase = {
  contacts: [],
  lists: [],
  conversations: {},
  messages: [],
  campaigns: [],
  templates: [],
  templateConfigs: {},
  events: [],
  leads: [],
  settings: {
    followup1Days: 1,
    followup2Days: 3
  },
  connectedNumbers: [],
  pendingStatuses: {}
};

function normalizeDatabase(data) {
  const source = data && typeof data === "object" ? data : {};
  return {
    ...structuredClone(defaultDatabase),
    ...source,
    contacts: Array.isArray(source.contacts) ? source.contacts : [],
    lists: Array.isArray(source.lists) ? source.lists : [],
    conversations: source.conversations && typeof source.conversations === "object" ? source.conversations : {},
    messages: Array.isArray(source.messages) ? source.messages : [],
    campaigns: Array.isArray(source.campaigns) ? source.campaigns : [],
    templates: Array.isArray(source.templates) ? source.templates : [],
    templateConfigs: source.templateConfigs && typeof source.templateConfigs === "object" ? source.templateConfigs : {},
    events: Array.isArray(source.events) ? source.events : [],
    leads: Array.isArray(source.leads) ? source.leads : [],
    settings: { ...structuredClone(defaultDatabase.settings), ...(source.settings || {}) },
    connectedNumbers: Array.isArray(source.connectedNumbers) ? source.connectedNumbers : []
  };
}

function loadLocalDatabase() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaultDatabase, null, 2));
      return structuredClone(defaultDatabase);
    }
    return normalizeDatabase(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch (error) {
    console.error("Database load error:", error);
    return structuredClone(defaultDatabase);
  }
}

async function loadDatabase() {
  if (!pgPool) return loadLocalDatabase();
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await pgPool.query("SELECT data FROM app_state WHERE id = $1", [DB_STATE_ID]);
    if (result.rows[0]?.data) return normalizeDatabase(result.rows[0].data);

    const local = loadLocalDatabase();
    await pgPool.query(
      `INSERT INTO app_state (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING`,
      [DB_STATE_ID, JSON.stringify(local)]
    );
    return local;
  } catch (error) {
    console.error("PostgreSQL load error; using local database fallback:", error);
    return loadLocalDatabase();
  }
}

function persistDatabaseNow() {
  const snapshot = JSON.stringify(db);
  if (!pgPool) {
    try { fs.writeFileSync(DATA_FILE, snapshot); } catch (error) { console.error("Database save error:", error); }
    return Promise.resolve();
  }
  return pgPool.query(
    `INSERT INTO app_state (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [DB_STATE_ID, snapshot]
  ).catch(error => console.error("PostgreSQL save error:", error));
}

function saveDatabase() {
  if (dbSaveTimer) clearTimeout(dbSaveTimer);
  dbSaveTimer = setTimeout(() => {
    dbSaveTimer = null;
    dbSaveQueued = true;
    if (dbSaveInFlight) return;
    dbSaveQueued = false;
    dbSaveInFlight = persistDatabaseNow().finally(() => {
      dbSaveInFlight = null;
      if (dbSaveQueued) saveDatabase();
    });
  }, DB_PERSIST_DEBOUNCE_MS);
}


function now() { return new Date().toISOString(); }
function cleanPhone(value) { return String(value || "").replace(/\D/g, ""); }
function makeId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
function addEvent(type, data = {}) {
  db.events.unshift({ id: makeId("event"), type, timestamp: now(), data });
  db.events = db.events.slice(0, 1000);
  saveDatabase();
}
function getContact(phone) {
  const normalized = cleanPhone(phone);
  return db.contacts.find(c => cleanPhone(c.wa_id || c.phone) === normalized);
}
function upsertContact(data) {
  const phone = cleanPhone(data.wa_id || data.phone);
  if (!phone) return null;
  let contact = getContact(phone);
  if (!contact) {
    contact = {
      id: makeId("contact"),
      name: data.name || data.profileName || "WhatsApp Contact",
      countryCode: data.countryCode || "",
      phone,
      wa_id: phone,
      language: data.language || "",
      tags: Array.isArray(data.tags) ? data.tags : [],
      labels: Array.isArray(data.labels) ? data.labels : [],
      lists: [],
      variables: Array.isArray(data.variables) ? data.variables : [],
      createdAt: now(),
      updatedAt: now()
    };
    db.contacts.push(contact);
  } else {
    if (data.name) contact.name = data.name;
    if (data.language) contact.language = data.language;
    if (Array.isArray(data.variables) && data.variables.length) contact.variables = data.variables;
    if (Array.isArray(data.labels)) contact.labels = [...new Set([...(contact.labels || []), ...data.labels])];
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
function metaRequest(endpoint, options = {}) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN is not configured.");
  return fetch(`${GRAPH_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  }).then(async response => {
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || "Meta API request failed");
      error.status = response.status;
      error.meta = data;
      throw error;
    }
    return data;
  });
}
function stageColor(stage) { return STAGE_META[stage]?.color || "#64748b"; }
function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + Number(days || 0) * 86400000).toISOString();
}
function leadForPhone(phone) {
  const p = cleanPhone(phone);
  return db.leads.find(l => cleanPhone(l.phone) === p);
}
function leadForBitrix(id) {
  return db.leads.find(l => String(l.bitrixId) === String(id));
}
function createOrUpdateLead(data = {}) {
  const phone = cleanPhone(data.phone);
  if (!phone) return null;
  let lead = data.bitrixId ? leadForBitrix(data.bitrixId) : leadForPhone(phone);
  const contact = upsertContact({
    phone,
    wa_id: phone,
    name: data.name,
    language: data.language
  });
  if (!lead) {
    lead = {
      id: makeId("lead"),
      bitrixId: data.bitrixId || null,
      contactId: contact?.id || null,
      name: data.name || contact?.name || phone,
      phone,
      language: data.language || contact?.language || "",
      source: data.source || "Bitrix",
      stage: data.stage || null,
      stageHistory: data.stage ? [{ stage: data.stage, at: now(), reason: "created" }] : [],
      optOut: false,
      createdAt: data.createdAt || now(),
      updatedAt: now()
    };
    db.leads.push(lead);
  } else {
    lead.contactId = contact?.id || lead.contactId;
    lead.bitrixId = data.bitrixId || lead.bitrixId;
    lead.name = data.name || lead.name;
    lead.language = data.language || lead.language;
    lead.updatedAt = now();
  }
  saveDatabase();
  return lead;
}
function setLeadStage(lead, stage, reason = "manual") {
  if (!lead) return null;
  if (lead.stage !== stage) {
    lead.stage = stage;
    lead.stageHistory = Array.isArray(lead.stageHistory) ? lead.stageHistory : [];
    lead.stageHistory.push({ stage, at: now(), reason });
    if (lead.stageHistory.length > 100) lead.stageHistory = lead.stageHistory.slice(-100);
  }
  lead.updatedAt = now();
  saveDatabase();
  addEvent("lead_stage_changed", { leadId: lead.id, phone: lead.phone, stage, reason });
  return lead;
}
function scheduleAfterInitial(lead, contactedAt) {
  lead.contactedAt = contactedAt;
  lead.followup1DueAt = addDays(contactedAt, db.settings.followup1Days);
  lead.followup1SentAt = null;
  lead.followup2DueAt = null;
  lead.followup2SentAt = null;
}
function scheduleAfterFollowup1(lead, sentAt) {
  lead.followup1SentAt = sentAt;
  lead.followup2DueAt = addDays(sentAt, db.settings.followup2Days);
}
function scheduleAfterFollowup2(lead, sentAt) {
  lead.followup2SentAt = sentAt;
}
function markContacted(lead, messageMeta, isInitial = false) {
  const sentAt = messageMeta.sentAt || now();
  if (isInitial || !lead.contactedAt) {
    scheduleAfterInitial(lead, sentAt);
    setLeadStage(lead, STAGES.CONTACTED, "initial_message_sent");
  } else if (!lead.followup1SentAt) {
    scheduleAfterFollowup1(lead, sentAt);
    setLeadStage(lead, STAGES.FOLLOWUP_DONE, "followup_1_sent");
  } else if (!lead.followup2SentAt) {
    scheduleAfterFollowup2(lead, sentAt);
    setLeadStage(lead, STAGES.WAITING_RESPONSE, "followup_2_sent");
  } else {
    setLeadStage(lead, STAGES.WAITING_RESPONSE, "followup_sequence_completed");
  }
  lead.lastMessageAt = sentAt;
  lead.lastTemplate = messageMeta.templateName || null;
  lead.lastMessageId = messageMeta.messageId || null;
  lead.updatedAt = sentAt;
  saveDatabase();
}
function processLeadTimers() {
  const t = Date.now();
  for (const lead of db.leads) {
    if (lead.optOut || lead.stage === STAGES.JUNK || lead.stage === STAGES.PHOTO_RECEIVED || lead.stage === STAGES.WAITING_RESPONSE) continue;
    if (lead.contactedAt && !lead.followup1SentAt && lead.followup1DueAt && new Date(lead.followup1DueAt).getTime() <= t && lead.stage === STAGES.CONTACTED) {
      setLeadStage(lead, STAGES.PENDING_FOLLOWUP, "followup_1_due");
    }
    if (lead.followup1SentAt && !lead.followup2SentAt && lead.followup2DueAt && new Date(lead.followup2DueAt).getTime() <= t && lead.stage === STAGES.FOLLOWUP_DONE) {
      setLeadStage(lead, STAGES.PENDING_FOLLOWUP, "followup_2_due");
    }
  }
}
setInterval(processLeadTimers, 30000);
processLeadTimers();

function applyStatusToMessage(message, status) {
  if (!message || !status) return;
  message.status = status.status || message.status || "sent";
  message.statusTimestamp = status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : now();
  message.statusErrors = status.errors || [];
  message.statusRecipient = status.recipient_id || message.statusRecipient || null;
}
function applyPendingStatus(messageId) {
  if (!messageId) return null;
  const pending = db.pendingStatuses?.[messageId];
  if (!pending) return null;
  const message = db.messages.find(m => m.wamid === messageId);
  if (!message) return null;
  applyStatusToMessage(message, pending);
  delete db.pendingStatuses[messageId];
  return pending;
}
function renderTemplateText(templateName, language, components = []) {
  const template = templateByKey(templateName, language);
  if (!template) return templateName ? `Template: ${templateName}` : "";
  let text = "";
  const body = (template.components || []).find(c => String(c.type).toUpperCase() === "BODY");
  if (body?.text) text = String(body.text);
  const bodyParams = (components || []).find(c => String(c.type).toLowerCase() === "body")?.parameters || [];
  bodyParams.forEach((p, i) => { text = text.replace(`{{${i+1}}}`, String(p.text ?? "")); });
  return text || `Template: ${templateName}`;
}
function storeOutboundMessage({ to, messageId, type, text = "", templateName = null, templateLanguage = null, templateComponents = [], metaResponse = null, leadId = null, action = null }) {
  const phone = cleanPhone(to);
  upsertContact({ phone, wa_id: phone });
  const conversation = getConversation(phone);
  const message = {
    id: makeId("msg"),
    wamid: messageId,
    wa_id: phone,
    direction: "outbound",
    type,
    text: text || (type === "template" ? renderTemplateText(templateName, templateLanguage, templateComponents) : ""),
    templateName,
    templateLanguage,
    templateComponents,
    status: "sent",
    timestamp: now(),
    metaResponse,
    leadId: leadId || null,
    action: action || null
  };
  db.messages.push(message);
  applyPendingStatus(messageId);
  conversation.lastMessage = message.text || `Template: ${templateName || ""}`;
  conversation.lastMessageAt = message.timestamp;
  conversation.lastDirection = "outbound";
  saveDatabase();
  return message;
}
async function sendTextMessage(to, body, meta = {}) {
  const recipient = cleanPhone(to);
  if (!recipient) throw new Error("Invalid recipient number.");
  if (!body || !String(body).trim()) throw new Error("Message text is required.");
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "text",
    text: { preview_url: false, body: String(body) }
  };
  const result = await metaRequest(`/${PHONE_NUMBER_ID}/messages`, { method: "POST", body: JSON.stringify(payload) });
  const messageId = result?.messages?.[0]?.id || null;
  storeOutboundMessage({ to: recipient, messageId, type: "text", text: body, metaResponse: result, leadId: meta.leadId, action: meta.action });
  return result;
}
function getTemplateConfigKey(template) {
  return `${template?.name || ""}::${template?.language || ""}`;
}
function templateByKey(name, language) {
  return db.templates.find(t => t.name === name && t.language === language);
}
function getTemplateConfig(template) {
  return db.templateConfigs[getTemplateConfigKey(template)] || {};
}
function templateHasImageHeader(template) {
  return !!(template?.components || []).find(c => String(c.type).toUpperCase() === "HEADER" && String(c.format || "").toUpperCase() === "IMAGE");
}
function extractTemplateVariables(template) {
  const out = [];
  (template?.components || []).forEach(component => {
    const type = String(component.type || "").toUpperCase();
    if (type === "BODY" || type === "HEADER") {
      const text = component.text || "";
      const matches = text.match(/\{\{\d+\}\}/g) || [];
      matches.forEach((placeholder, i) => out.push({ key: placeholder, component: type, index: i }));
    }
  });
  return out;
}
function extractTemplateButtons(template) {
  const out = [];
  (template?.components || []).forEach((component, componentIndex) => {
    if (String(component.type || "").toUpperCase() !== "BUTTONS") return;
    (component.buttons || []).forEach((button, index) => {
      out.push({
        index: String(index),
        type: String(button.type || "").toUpperCase(),
        text: button.text || "",
        url: button.url || "",
        example: button.example || null,
        componentIndex
      });
    });
  });
  return out;
}

function normalizeLanguageName(value){
  const x=String(value||"").toLowerCase();
  const map={
    english:["english","en","en_us","en_gb"],italiano:["italian","italiano","it","it_it"],
    "français":["french","français","francais","fr","fr_fr"],español:["spanish","español","es","es_es"],
    română:["romanian","română","ro","ro_ro"],deutsch:["german","deutsch","de","de_de"],
    русский:["russian","русский","ru","ru_ru"],türkçe:["turkish","türkçe","tr","tr_tr"],
    polski:["polish","polski","pl","pl_pl"],português:["portuguese","português","pt","pt_pt","pt_br"],
    ελληνικά:["greek","ελληνικά","el","el_gr"],bosnian:["bosnian","bs","bs_ba"],bulgarian:["bulgarian","bg","bg_bg"]
  };
  for(const [canonical,values] of Object.entries(map)) if(values.includes(x)) return canonical;
  return x;
}
function chooseTemplateForLead(templateName, language){
  const candidates=db.templates.filter(t=>t.name===templateName&&String(t.status).toUpperCase()==="APPROVED");
  if(!candidates.length)return null;
  const wanted=normalizeLanguageName(language);
  return candidates.find(t=>normalizeLanguageName(t.language)===wanted)||candidates.find(t=>String(t.language||"").toLowerCase().startsWith(String(language||"").toLowerCase()))||candidates[0];
}
function buildTemplateComponents(template, input = {}) {
  const variables = Array.isArray(input.variables) ? input.variables : [];
  let variableIndex = 0;
  const components = [];
  const header = (template?.components || []).find(c => String(c.type).toUpperCase() === "HEADER");
  const body = (template?.components || []).find(c => String(c.type).toUpperCase() === "BODY");
  const buttons = (template?.components || []).find(c => String(c.type).toUpperCase() === "BUTTONS");
  if (header) {
    const format = String(header.format || "").toUpperCase();
    const matches = String(header.text || "").match(/\{\{\d+\}\}/g) || [];
    if (format === "IMAGE") {
      const mediaUrl = input.mediaUrl || getTemplateConfig(template).mediaUrl;
      if (!mediaUrl) throw new Error(`Template "${template.name}" requires a fixed image URL. Configure it in Templates.`);
      components.push({ type: "header", parameters: [{ type: "image", image: { link: mediaUrl } }] });
    } else if (matches.length) {
      components.push({
        type: "header",
        parameters: matches.map(() => ({ type: "text", text: String(variables[variableIndex++] ?? "") }))
      });
    }
  }
  if (body) {
    const matches = String(body.text || "").match(/\{\{\d+\}\}/g) || [];
    if (matches.length) {
      const params = matches.map(() => ({ type: "text", text: String(variables[variableIndex++] ?? "") }));
      if (params.some(p => !p.text.trim())) throw new Error("Please fill all required template variables.");
      components.push({ type: "body", parameters: params });
    }
  }
  if (buttons?.buttons?.length) {
    buttons.buttons.forEach((button, index) => {
      const type = String(button.type || "").toUpperCase();
      if (type === "QUICK_REPLY") {
        const payload = input.buttonPayloads?.[String(index)] ?? button.text ?? "";
        components.push({
          type: "button",
          sub_type: "quick_reply",
          index: String(index),
          parameters: [{ type: "payload", payload: String(payload) }]
        });
      } else if (type === "URL" && Array.isArray(input.buttonParameters?.[String(index)])) {
        components.push({
          type: "button",
          sub_type: "url",
          index: String(index),
          parameters: input.buttonParameters[String(index)].map(v => ({ type: "text", text: String(v) }))
        });
      }
    });
  }
  return components;
}
async function sendTemplateMessage({ to, name, language, components = [], leadId = null, action = null }) {
  const recipient = cleanPhone(to);
  if (!recipient) throw new Error("Invalid recipient number.");
  if (!name || !language) throw new Error("Template name and language are required.");
  const template = templateByKey(name, language) || { name, language, components: [] };
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "template",
    template: { name, language: { code: language }, ...(components.length ? { components } : {}) }
  };
  const result = await metaRequest(`/${PHONE_NUMBER_ID}/messages`, { method: "POST", body: JSON.stringify(payload) });
  const messageId = result?.messages?.[0]?.id || null;
  storeOutboundMessage({
    to: recipient,
    messageId,
    type: "template",
    templateName: name,
    templateLanguage: language,
    templateComponents: components,
    metaResponse: result,
    leadId,
    action
  });
  return result;
}
async function sendLeadMessage({ lead, template, variables = [], mediaUrl = "", buttonPayloads = {}, buttonParameters = {}, action = "initial" }) {
  if (!template) throw new Error("Approved template is required.");
  const components = buildTemplateComponents(template, { variables, mediaUrl, buttonPayloads, buttonParameters });
  const result = await sendTemplateMessage({
    to: lead.phone,
    name: template.name,
    language: template.language,
    components,
    leadId: lead.id,
    action
  });
  const messageId = result?.messages?.[0]?.id || null;
  const sentAt = now();
  if (action === "initial") markContacted(lead, { messageId, templateName: template.name, sentAt }, true);
  else if (action === "followup1") markContacted(lead, { messageId, templateName: template.name, sentAt }, false);
  else if (action === "followup2") markContacted(lead, { messageId, templateName: template.name, sentAt }, false);
  return { result, messageId, sentAt, components };
}

/* Health/config */
app.get("/api/health", (req,res) => res.json({ ok:true, service:"Royal Hair Istanbul WhatsApp Dashboard", timestamp:now(), whatsappConfigured:Boolean(WHATSAPP_TOKEN&&PHONE_NUMBER_ID&&WABA_ID), bitrixConfigured:Boolean(BITRIX_WEBHOOK_URL) }));
app.get("/api/config", (req,res) => res.json({
  configured:Boolean(WHATSAPP_TOKEN&&PHONE_NUMBER_ID&&WABA_ID),
  phoneNumberId:PHONE_NUMBER_ID||"",
  wabaId:WABA_ID||"",
  graphApiVersion:GRAPH_API_VERSION,
  connectedNumber:process.env.CONNECTED_WHATSAPP_NUMBER || ""
}));

app.get("/api/diagnostics/whatsapp", async (req,res) => {
  const result = { timestamp: now(), config: { token: !!WHATSAPP_TOKEN, phoneNumberId: !!PHONE_NUMBER_ID, wabaId: !!WABA_ID, graphApiVersion: GRAPH_API_VERSION }, checks: {} };
  try {
    const me = await metaRequest(`/me`);
    result.checks.token = { ok: true, id: me?.id || null, name: me?.name || null };
  } catch (e) { result.checks.token = { ok: false, error: e.message, meta: e.meta || null }; }
  try {
    const phone = await metaRequest(`/${PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,quality_rating,status`);
    result.checks.phoneNumber = { ok: true, data: phone };
  } catch (e) { result.checks.phoneNumber = { ok: false, error: e.message, meta: e.meta || null }; }
  try {
    const subs = await metaRequest(`/${WABA_ID}/subscribed_apps`);
    result.checks.wabaSubscription = { ok: true, data: subs };
  } catch (e) { result.checks.wabaSubscription = { ok: false, error: e.message, meta: e.meta || null }; }
  result.checks.localWebhook = { ok: true, callback: `${req.protocol}://${req.get("host")}/webhook`, note: "Real WhatsApp events must appear in Render logs as POST /webhook." };
  result.recentEvents = db.events.slice(0, 25).filter(e => ["incoming_message","message_status","webhook"].includes(e.type));
  result.recentMessages = db.messages.slice(-25).reverse().map(m => ({ wamid:m.wamid, direction:m.direction, type:m.type, wa_id:m.wa_id, status:m.status, timestamp:m.timestamp, text:m.text }));
  res.json(result);
});

/* Countries */
app.get("/api/countries",(req,res)=>{
  const displayNames = new Intl.DisplayNames(["en"],{type:"region"});
  const countries = getCountries().map(iso=>({iso,name:displayNames.of(iso)||iso,callingCode:getCountryCallingCode(iso)})).filter(c=>c.callingCode).sort((a,b)=>a.name.localeCompare(b.name));
  res.json({data:countries});
});

/* Bitrix */
app.get("/api/bitrix/test", async (req,res)=>{
  try {
    if(!BITRIX_WEBHOOK_URL) return res.status(500).json({ok:false,error:"BITRIX_WEBHOOK_URL is not configured"});
    const base = BITRIX_WEBHOOK_URL.endsWith("/") ? BITRIX_WEBHOOK_URL : `${BITRIX_WEBHOOK_URL}/`;
    const r = await fetch(`${base}profile.json`); const data=await r.json();
    if(!r.ok || data.error) throw new Error(data.error_description||data.error||"Bitrix API failed");
    res.json({ok:true,user:data.result||null});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get("/api/bitrix/lead-fields", async (req,res)=>{
  try {
    if(!BITRIX_WEBHOOK_URL) throw new Error("BITRIX_WEBHOOK_URL is not configured");
    const r=await fetch(`${BITRIX_WEBHOOK_URL}crm.item.fields.json?entityTypeId=1`); const data=await r.json();
    if(!r.ok||data.error) throw new Error(data.error_description||data.error||"Bitrix API error");
    const fields=data.result?.fields||{};
    const languageField=Object.entries(fields).find(([code,field])=>String(field.title||"").toLowerCase()==="language");
    res.json({ok:true,languageField:languageField?{code:languageField[0],details:languageField[1]}:null,fields});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get("/api/bitrix/leads", async (req,res)=>{
  try {
    if(!BITRIX_WEBHOOK_URL) return res.status(500).json({ok:false,error:"BITRIX_WEBHOOK_URL is not configured"});
    const filters={stageId:"NEW"};
    if(req.query.dateFrom) filters[">=dateCreate"]=`${req.query.dateFrom}T00:00:00`;
    if(req.query.dateTo) filters["<=dateCreate"]=`${req.query.dateTo}T23:59:59`;
    if(req.query.language) filters["ufCrm_1690811363903"]=req.query.language;
    const r=await fetch(`${BITRIX_WEBHOOK_URL}crm.item.list.json`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        entityTypeId:1,
        select:["id","title","phone","PHONE","ufCrm_1690811363903","dateCreate","dateModify","stageId"],
        filter:filters,order:{id:"DESC"},start:0
      })
    });
    const data=await r.json();
    if(!r.ok||data.error) throw new Error(data.error_description||data.error||"Bitrix API error");
    const items=data.result?.items||[];
    res.json({ok:true,data:items});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get("/api/bitrix/lead/:id", async (req,res)=>{
  try {
    if(!BITRIX_WEBHOOK_URL) throw new Error("BITRIX_WEBHOOK_URL is not configured");
    const id=Number(req.params.id); if(!id) return res.status(400).json({ok:false,error:"Invalid lead ID"});
    const r=await fetch(`${BITRIX_WEBHOOK_URL}crm.item.get.json`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({entityTypeId:1,id})});
    const data=await r.json();
    if(!r.ok||data.error) throw new Error(data.error_description||data.error||"Bitrix API error");
    const lead=data.result?.item; if(!lead) return res.status(404).json({ok:false,error:"Lead not found"});
    const pf=lead.PHONE||lead.phone||[];
    const phone=Array.isArray(pf)?(pf.find(p=>p.VALUE)?.VALUE||pf.find(p=>p.value)?.value||null):(pf||null);
    res.json({ok:true,lead:{id:lead.id,title:lead.title,phone,languageValue:lead.ufCrm_1690811363903||"",stageId:lead.stageId||""}});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post("/api/bitrix/send-template", async (req,res)=>{
  try {
    const {leadId,templateName,languageCode,components=[],action="initial"}=req.body||{};
    if(!leadId||!templateName||!languageCode) return res.status(400).json({ok:false,error:"leadId, templateName and languageCode are required"});
    const leadResponse=await fetch(`${BITRIX_WEBHOOK_URL}crm.item.get.json`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({entityTypeId:1,id:Number(leadId)})});
    const leadData=await leadResponse.json(); if(!leadResponse.ok||leadData.error) throw new Error(leadData.error_description||leadData.error||"Could not retrieve Bitrix lead");
    const b=leadData.result?.item; if(!b) return res.status(404).json({ok:false,error:"Bitrix lead not found"});
    const pf=b.PHONE||b.phone||[]; const phone=Array.isArray(pf)?(pf.find(p=>p.VALUE)?.VALUE||pf.find(p=>p.value)?.value||null):(pf||null);
    if(!phone) return res.status(400).json({ok:false,error:"No phone number found on this Bitrix lead"});
    const language = languageCode;
    const tpl = templateByKey(templateName,language);
    const lead=createOrUpdateLead({bitrixId:Number(leadId),phone,name:b.title||`Lead #${leadId}`,language,source:"Meta Ads",createdAt:b.dateCreate||now()});
    const result=await sendTemplateMessage({to:phone,name:templateName,language,components,leadId:lead.id,action});
    const sentAt=now(); markContacted(lead,{messageId:result?.messages?.[0]?.id||null,templateName,sentAt},action==="initial");
    res.json({ok:true,leadId:Number(leadId),phone,contactedAt:lead.contactedAt,stage:lead.stage,followup1DueAt:lead.followup1DueAt,followup2DueAt:lead.followup2DueAt,whatsapp:result,template:tpl||null});
  } catch(e){res.status(e.status||500).json({ok:false,error:e.message,meta:e.meta||null});}
});

/* Templates */
async function fetchAllTemplates(){
  if(!WABA_ID) throw new Error("WABA_ID is not configured.");
  let url=`/${WABA_ID}/message_templates?fields=id,name,status,category,language,components,quality_score&limit=100`;
  const all=[]; let pages=0;
  while(url&&pages<20){const data=await metaRequest(url); if(Array.isArray(data.data)) all.push(...data.data); url=data?.paging?.next?data.paging.next.replace(GRAPH_URL,""):null; pages++;}
  db.templates=all; saveDatabase(); addEvent("templates_synced",{count:all.length}); return all;
}
app.get("/api/templates",async(req,res)=>{try{const data=await fetchAllTemplates();res.json({success:true,data});}catch(e){res.status(e.status||500).json({success:false,error:e.message,meta:e.meta||null,cached:db.templates});}});
app.post("/api/templates/sync",async(req,res)=>{try{const data=await fetchAllTemplates();res.json({success:true,count:data.length,data});}catch(e){res.status(e.status||500).json({success:false,error:e.message,meta:e.meta||null});}});
app.get("/api/templates/config",(req,res)=>res.json({data:db.templateConfigs}));
app.post("/api/templates/config",(req,res)=>{
  const {name,language,mediaUrl}=req.body||{};
  if(!name||!language) return res.status(400).json({error:"Template name and language are required."});
  const key=`${name}::${language}`;
  db.templateConfigs[key]={mediaUrl:String(mediaUrl||"").trim(),updatedAt:now()};
  saveDatabase(); res.json({success:true,data:db.templateConfigs[key]});
});
app.get("/api/templates/:name/:language/meta",(req,res)=>{
  const t=templateByKey(req.params.name,req.params.language);
  if(!t) return res.status(404).json({error:"Template not found"});
  res.json({data:{...t,config:getTemplateConfig(t),variables:extractTemplateVariables(t),buttons:extractTemplateButtons(t)}});
});

/* Contacts / labels */
app.get("/api/contacts",(req,res)=>res.json({data:db.contacts}));
app.post("/api/contacts/import",(req,res)=>{
  try{
    const contacts=Array.isArray(req.body?.contacts)?req.body.contacts:[]; const label=String(req.body?.label||"").trim();
    let imported=0,updated=0;
    contacts.forEach(item=>{
      const phone=cleanPhone(item.phone||item.number||item.wa_id); if(!phone)return;
      const existing=getContact(phone);
      const contact=upsertContact({...item,phone,wa_id:phone,labels:label?[label]:[]});
      if(existing)updated++; else if(contact)imported++;
      if(label&&contact&&!contact.labels.includes(label))contact.labels.push(label);
    });
    saveDatabase(); res.json({success:true,imported,updated,total:imported+updated,label});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});
app.post("/api/leads/import-contacts",(req,res)=>{
  try{
    const contactIds=Array.isArray(req.body?.contactIds)?req.body.contactIds:[];
    const label=String(req.body?.label||"").trim();
    let added=0,updated=0,skipped=0;
    let selected=contactIds.length ? db.contacts.filter(c=>contactIds.includes(c.id)) : db.contacts.filter(c=>label&&(c.labels||[]).includes(label));
    selected.forEach(contact=>{
      const phone=cleanPhone(contact.phone||contact.wa_id);
      if(!phone){skipped++;return;}
      let lead=leadForPhone(phone);
      if(lead){
        lead.name=contact.name||lead.name||phone;
        lead.language=contact.language||lead.language||"";
        lead.contactId=contact.id;
        lead.source=lead.source||"Contact Import";
        updated++;
      }else{
        lead=createOrUpdateLead({phone,name:contact.name||phone,language:contact.language||"",source:"Contact Import",contactId:contact.id});
        added++;
      }
      if(lead.optOut||lead.stage===STAGES.JUNK){skipped++;return;}
      const contactedAt=lead.contactedAt||now();
      if(!lead.contactedAt) scheduleAfterInitial(lead,contactedAt);
      setLeadStage(lead,STAGES.CONTACTED,"contact_import");
      lead.contactedAt=lead.contactedAt||contactedAt;
      lead.source=lead.source||"Contact Import";
      lead.updatedAt=now();
    });
    saveDatabase();
    res.json({success:true,added,updated,skipped,total:selected.length});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});
app.get("/api/contacts/labels",(req,res)=>{
  const counts={};
  db.contacts.forEach(c=>(c.labels||[]).forEach(l=>counts[l]=(counts[l]||0)+1));
  res.json({data:Object.entries(counts).map(([name,count])=>({name,count}))});
});

/* Generic lists */
app.get("/api/lists",(req,res)=>res.json({data:db.lists.map(l=>({...l,contactCount:l.contactIds.length}))}));
app.post("/api/lists",(req,res)=>{
  const name=String(req.body?.name||"").trim(); if(!name)return res.status(400).json({error:"List name is required."});
  const list={id:makeId("list"),name,contactIds:[],createdAt:now()};db.lists.push(list);saveDatabase();res.json({success:true,data:list});
});
app.post("/api/lists/:listId/contacts",(req,res)=>{
  const list=db.lists.find(l=>l.id===req.params.listId);const ids=Array.isArray(req.body?.contactIds)?req.body.contactIds:[];
  if(!list)return res.status(404).json({error:"List not found"});let added=0;
  ids.forEach(id=>{const c=db.contacts.find(x=>x.id===id);if(c&&!list.contactIds.includes(id)){list.contactIds.push(id);c.lists=c.lists||[];if(!c.lists.includes(list.id))c.lists.push(list.id);added++;}});
  saveDatabase();res.json({success:true,added});
});

/* Leads */
app.get("/api/leads",(req,res)=>{
  processLeadTimers();
  let leads=[...db.leads];
  if(req.query.stage) leads=leads.filter(l=>l.stage===req.query.stage);
  if(req.query.language) leads=leads.filter(l=>String(l.language||"").toLowerCase()===String(req.query.language).toLowerCase());
  if(req.query.q){const q=String(req.query.q).toLowerCase();leads=leads.filter(l=>[l.name,l.phone,l.language,l.bitrixId].some(v=>String(v||"").toLowerCase().includes(q)));}
  if(req.query.from) leads=leads.filter(l=>new Date(l.createdAt)>=new Date(`${req.query.from}T00:00:00`));
  if(req.query.to) leads=leads.filter(l=>new Date(l.createdAt)<=new Date(`${req.query.to}T23:59:59`));
  leads.sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt));
  res.json({data:leads,stageMeta:STAGE_META,stages:Object.values(STAGES)});
});
app.get("/api/leads/stats",(req,res)=>{
  processLeadTimers();
  const total=db.leads.filter(l=>l.stage&&l.stage!==STAGES.JUNK).length;
  const stats={};Object.values(STAGES).forEach(s=>stats[s]=db.leads.filter(l=>l.stage===s).length);
  const contacted=db.leads.filter(l=>l.contactedAt).length;
  res.json({total,contacted,stats,percentages:Object.fromEntries(Object.entries(stats).map(([k,v])=>[k,contacted?Number((v/contacted*100).toFixed(1)):0]))});
});
app.get("/api/leads/:id",(req,res)=>{const lead=db.leads.find(l=>l.id===req.params.id);if(!lead)return res.status(404).json({error:"Lead not found"});res.json({data:lead});});
app.post("/api/leads/upsert",(req,res)=>{const lead=createOrUpdateLead(req.body||{});if(!lead)return res.status(400).json({error:"Phone is required"});res.json({success:true,data:lead});});
app.post("/api/leads/:id/stage",(req,res)=>{
  const lead=db.leads.find(l=>l.id===req.params.id);const stage=req.body?.stage;
  if(!lead||!Object.values(STAGES).includes(stage))return res.status(400).json({error:"Invalid lead or stage"});
  if(stage===STAGES.JUNK)lead.optOut=true;
  setLeadStage(lead,stage,"manual");
  res.json({success:true,data:lead});
});
app.post("/api/leads/bulk-stage",(req,res)=>{
  const ids=Array.isArray(req.body?.leadIds)?req.body.leadIds:[];const stage=req.body?.stage;
  if(!Object.values(STAGES).includes(stage))return res.status(400).json({error:"Invalid stage"});
  let changed=0;ids.forEach(id=>{const lead=db.leads.find(l=>l.id===id);if(lead){if(stage===STAGES.JUNK)lead.optOut=true;setLeadStage(lead,stage,"bulk_manual");changed++;}});
  res.json({success:true,changed});
});
app.delete("/api/leads/:id",(req,res)=>{const idx=db.leads.findIndex(l=>l.id===req.params.id);if(idx<0)return res.status(404).json({error:"Lead not found"});db.leads.splice(idx,1);saveDatabase();res.json({success:true});});
app.post("/api/leads/:id/optout",(req,res)=>{const lead=db.leads.find(l=>l.id===req.params.id);if(!lead)return res.status(404).json({error:"Lead not found"});lead.optOut=true;setLeadStage(lead,STAGES.JUNK,"opt_out");res.json({success:true,data:lead});});

/* Lead message endpoint */
app.post("/api/leads/:id/send",(req,res)=>{
  (async()=>{
    try{
      const lead=db.leads.find(l=>l.id===req.params.id);if(!lead)return res.status(404).json({error:"Lead not found"});
      if(lead.optOut||lead.stage===STAGES.JUNK)return res.status(400).json({error:"Lead is opted out/Junk and cannot be messaged automatically."});
      const {type="template",text,templateName,language,variables=[],mediaUrl,buttonPayloads={},buttonParameters={},action="initial"}=req.body||{};
      if(type==="text"){
        const result=await sendTextMessage(lead.phone,text,{leadId:lead.id,action});
        if(action==="initial") markContacted(lead,{messageId:result?.messages?.[0]?.id||null,templateName:null,sentAt:now()},true);
        return res.json({success:true,result,lead});
      }
      const template=templateByKey(templateName,language);if(!template)return res.status(400).json({error:"Approved template not found. Sync templates first."});
      if(String(template.status).toUpperCase()!=="APPROVED")return res.status(400).json({error:"Template is not approved."});
      const sent=await sendLeadMessage({lead,template,variables,mediaUrl,buttonPayloads,buttonParameters,action});
      res.json({success:true,...sent,lead});
    }catch(e){res.status(e.status||500).json({success:false,error:e.message,meta:e.meta||null});}
  })();
});

/* Generic single message API */
app.post("/api/messages/send", async (req,res)=>{
  try{
    const {to,type="text",text,template}=req.body||{};
    if(type==="text"){
      const result=await sendTextMessage(to,text,{action:"manual"});
      return res.json({success:true,result});
    }
    const t=templateByKey(template?.name,template?.language);
    if(!t||String(t.status).toUpperCase()!=="APPROVED") return res.status(400).json({error:"Approved template not found."});
    const variables=Array.isArray(template?.variables)?template.variables:[];
    const components=buildTemplateComponents(t,{variables,mediaUrl:template?.mediaUrl,buttonPayloads:template?.buttonPayloads||{},buttonParameters:template?.buttonParameters||{}});
    const result=await sendTemplateMessage({to,name:t.name,language:t.language,components,action:"manual"});
    res.json({success:true,result});
  }catch(e){res.status(e.status||500).json({success:false,error:e.message,meta:e.meta||null});}
});

/* Campaigns / broadcast */
const MIN_CAMPAIGN_DELAY_MS = Math.max(1000, Number(process.env.MIN_CAMPAIGN_DELAY_MS || 3000));
const MAX_CAMPAIGN_DELAY_MS = Math.max(MIN_CAMPAIGN_DELAY_MS, Number(process.env.MAX_CAMPAIGN_DELAY_MS || 10000));
const campaignWorkers = new Set();

function campaignDelayMs(requested) {
  const value = Number(requested);
  if (!Number.isFinite(value)) return MIN_CAMPAIGN_DELAY_MS;
  return Math.min(MAX_CAMPAIGN_DELAY_MS, Math.max(MIN_CAMPAIGN_DELAY_MS, value));
}

function campaignRecipientSnapshot(recipient) {
  return {
    id: recipient?.id || null,
    phone: cleanPhone(recipient?.phone || recipient?.wa_id || ""),
    name: recipient?.name || recipient?.profileName || "",
    language: recipient?.language || "",
    variables: Array.isArray(recipient?.variables) ? recipient.variables : []
  };
}

async function runCampaign(campaign) {
  if (!campaign || campaign.status !== "running" || campaignWorkers.has(campaign.id)) return;
  campaignWorkers.add(campaign.id);
  campaign.workerRunning = true;
  saveDatabase();
  try {
    const recipients = Array.isArray(campaign.recipients) ? campaign.recipients : [];
    while (campaign.status === "running" && campaign.nextIndex < recipients.length) {
      const recipient = recipients[campaign.nextIndex];
      const lead = recipient.phone ? (leadForPhone(recipient.phone) || createOrUpdateLead({
        phone: recipient.phone,
        name: recipient.name || recipient.phone,
        language: recipient.language || "",
        source: "Contact Broadcast"
      })) : null;

      try {
        if (!recipient.phone) throw new Error("Recipient has no phone number.");
        if (lead?.optOut || lead?.stage === STAGES.JUNK) throw new Error("Recipient is opted out/Junk.");

        const baseTemplate = templateByKey(campaign.templateName, campaign.language);
        if (!baseTemplate || String(baseTemplate.status).toUpperCase() !== "APPROVED") {
          throw new Error("Approved campaign template is no longer available.");
        }

        const template = campaign.autoLanguage
          ? (chooseTemplateForLead(campaign.templateName, lead?.language) || baseTemplate)
          : baseTemplate;
        const vars = Array.isArray(campaign.variablesByLead?.[recipient.id])
          ? campaign.variablesByLead[recipient.id]
          : (Array.isArray(recipient.variables) ? recipient.variables : []);
        const mediaUrl = campaign.autoLanguage
          ? (getTemplateConfig(template).mediaUrl || campaign.mediaUrl || "")
          : (campaign.mediaUrl || getTemplateConfig(template).mediaUrl || "");
        const action = campaign.action === "broadcast" ? "initial" : campaign.action;
        const sent = await sendLeadMessage({
          lead,
          template,
          variables: vars,
          mediaUrl,
          buttonPayloads: campaign.buttonPayloads || {},
          buttonParameters: campaign.buttonParameters || {},
          action
        });

        campaign.sent = Number(campaign.sent || 0) + 1;
        campaign.results.push({
          contactId: recipient.id,
          leadId: lead?.id || null,
          phone: recipient.phone,
          status: "accepted",
          messageId: sent.messageId,
          timestamp: now()
        });
      } catch (e) {
        campaign.failed = Number(campaign.failed || 0) + 1;
        campaign.results.push({
          contactId: recipient.id,
          leadId: lead?.id || null,
          phone: recipient.phone,
          status: "failed",
          error: e.message,
          timestamp: now()
        });
      }

      campaign.nextIndex += 1;
      campaign.updatedAt = now();
      saveDatabase();

      if (campaign.status === "running" && campaign.nextIndex < recipients.length) {
        await new Promise(resolve => setTimeout(resolve, campaignDelayMs(campaign.delayMs)));
      }
    }

    if (campaign.status === "running" && campaign.nextIndex >= recipients.length) {
      campaign.status = "completed";
      campaign.completedAt = now();
      campaign.workerRunning = false;
      campaign.updatedAt = now();
      saveDatabase();
      addEvent("campaign_completed", { campaignId: campaign.id });
    }
  } catch (error) {
    campaign.status = "paused";
    campaign.workerRunning = false;
    campaign.error = error.message;
    campaign.updatedAt = now();
    saveDatabase();
    addEvent("campaign_paused", { campaignId: campaign.id, error: error.message });
  } finally {
    campaignWorkers.delete(campaign.id);
    campaign.workerRunning = false;
    saveDatabase();
  }
}

function resumeRunningCampaigns() {
  for (const campaign of db.campaigns) {
    if (campaign.status === "running" && Array.isArray(campaign.recipients)) {
      setTimeout(() => runCampaign(campaign), 1000);
    }
  }
}

app.get("/api/campaigns", (req,res)=>res.json({data:db.campaigns}));
app.post("/api/campaigns", (req,res)=>{
  try {
    const {name,leadIds,contactIds,listId,label,templateName,language,variablesByLead={},delayMs=3000,action="followup1",mediaUrl="",buttonPayloads={},buttonParameters={},autoLanguage=false}=req.body||{};
    const template=templateByKey(templateName,language);
    if(!template||String(template.status).toUpperCase()!=="APPROVED") return res.status(400).json({error:"An approved Meta template is required."});

    let recipients=[];
    if(Array.isArray(leadIds)&&leadIds.length) recipients=db.leads.filter(l=>leadIds.includes(l.id));
    else if(listId){const list=db.lists.find(l=>l.id===listId);if(!list)return res.status(404).json({error:"List not found"});recipients=db.contacts.filter(c=>list.contactIds.includes(c.id));}
    else if(label) recipients=db.contacts.filter(c=>(c.labels||[]).includes(label));
    else if(Array.isArray(contactIds)) recipients=contactIds.map(id=>db.contacts.find(c=>c.id===id)).filter(Boolean);

    recipients=recipients.filter(x=>x?.phone && !leadForPhone(x.phone)?.optOut && leadForPhone(x.phone)?.stage!==STAGES.JUNK);
    if(!recipients.length)return res.status(400).json({error:"No eligible contacts selected."});

    const campaign={
      id:makeId("campaign"),
      name:name||`Campaign ${new Date().toLocaleString()}`,
      templateName,language,action,status:"running",createdAt:now(),updatedAt:now(),
      total:recipients.length,sent:0,failed:0,delivered:0,read:0,nextIndex:0,
      delayMs:campaignDelayMs(delayMs),mediaUrl,buttonPayloads,buttonParameters,autoLanguage,
      variablesByLead,recipients:recipients.map(campaignRecipientSnapshot),results:[],workerRunning:false
    };
    db.campaigns.unshift(campaign);
    saveDatabase();
    addEvent("campaign_started", { campaignId: campaign.id, total: campaign.total, delayMs: campaign.delayMs });
    setTimeout(()=>runCampaign(campaign),100);
    res.json({success:true,campaignId:campaign.id,total:campaign.total,delayMs:campaign.delayMs});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/campaigns/:id/pause",(req,res)=>{
  const campaign=db.campaigns.find(c=>c.id===req.params.id);
  if(!campaign)return res.status(404).json({error:"Campaign not found"});
  if(campaign.status==="running")campaign.status="paused";
  campaign.updatedAt=now();saveDatabase();
  res.json({success:true,data:campaign});
});

app.post("/api/campaigns/:id/resume",(req,res)=>{
  const campaign=db.campaigns.find(c=>c.id===req.params.id);
  if(!campaign)return res.status(404).json({error:"Campaign not found"});
  if(campaign.nextIndex >= (campaign.recipients||[]).length)return res.status(400).json({error:"Campaign is already complete."});
  campaign.status="running";campaign.error=null;campaign.updatedAt=now();saveDatabase();
  setTimeout(()=>runCampaign(campaign),100);
  res.json({success:true,data:campaign});
});

/* Inbox */
app.get("/api/inbox",(req,res)=>{
  const conversations=Object.values(db.conversations).map(c=>({...c,contact:getContact(c.wa_id),lead:leadForPhone(c.wa_id)})).sort((a,b)=>new Date(b.lastMessageAt||0)-new Date(a.lastMessageAt||0));
  res.json({data:conversations});
});
app.get("/api/inbox/:waId/messages",(req,res)=>res.json({data:db.messages.filter(m=>cleanPhone(m.wa_id)===cleanPhone(req.params.waId))}));

async function uploadWhatsAppMedia(dataUrl, mimeType, filename){
  if(!WHATSAPP_TOKEN||!PHONE_NUMBER_ID) throw new Error("WhatsApp credentials are not configured.");
  const match=String(dataUrl||"").match(/^data:([^;]+);base64,(.+)$/);
  if(!match) throw new Error("Invalid media data.");
  const buffer=Buffer.from(match[2],"base64");
  const blob=new Blob([buffer],{type:mimeType||match[1]});
  const form=new FormData();
  form.append("messaging_product","whatsapp");
  form.append("file",blob,filename||"upload");
  const r=await fetch(`${GRAPH_URL}/${PHONE_NUMBER_ID}/media`,{method:"POST",headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`},body:form});
  const data=await r.json();
  if(!r.ok||data.error){const e=new Error(data?.error?.message||"Media upload failed");e.status=r.status;e.meta=data;throw e}
  return data.id;
}
app.post("/api/inbox/:waId/send-media",async(req,res)=>{
  try{
    const phone=cleanPhone(req.params.waId);const {dataUrl,mimeType,filename,caption=""}=req.body||{};
    if(!dataUrl)return res.status(400).json({error:"Media is required."});
    const mediaId=await uploadWhatsAppMedia(dataUrl,mimeType,filename);
    const type=String(mimeType||"").startsWith("image/")?"image":String(mimeType||"").startsWith("video/")?"video":String(mimeType||"").startsWith("audio/")?"audio":"document";
    const payload={messaging_product:"whatsapp",recipient_type:"individual",to:phone,type,[type]:{id:mediaId,...(caption?{caption}:{}),...(type==="document"&&filename?{filename}: {})}};
    const result=await metaRequest(`/${PHONE_NUMBER_ID}/messages`,{method:"POST",body:JSON.stringify(payload)});
    const messageId=result?.messages?.[0]?.id||null;
    storeOutboundMessage({to:phone,messageId,type, text:caption,metaResponse:result,leadId:leadForPhone(phone)?.id||null,action:"inbox_media"});
    res.json({success:true,result,mediaId});
  }catch(e){res.status(e.status||500).json({success:false,error:e.message,meta:e.meta||null});}
});

app.post("/api/inbox/:waId/send",async(req,res)=>{
  try{
    const phone=cleanPhone(req.params.waId);const {type="text",text,template}=req.body||{};let result;
    if(type==="template") result=await sendTemplateMessage({to:phone,name:template?.name,language:template?.language,components:template?.components||[],leadId:leadForPhone(phone)?.id||null,action:template?.action||"manual"});
    else result=await sendTextMessage(phone,text,{leadId:leadForPhone(phone)?.id||null,action:"manual"});
    res.json({success:true,result});
  }catch(e){res.status(e.status||500).json({success:false,error:e.message,meta:e.meta||null});}
});
app.post("/api/inbox/:waId/read",(req,res)=>{const c=db.conversations[cleanPhone(req.params.waId)];if(c)c.unread=0;saveDatabase();res.json({success:true});});
app.post("/api/inbox/:waId/stage",(req,res)=>{const lead=leadForPhone(req.params.waId);if(!lead)return res.status(404).json({error:"Lead not found"});if(req.body?.stage===STAGES.JUNK)lead.optOut=true;setLeadStage(lead,req.body?.stage,"inbox");res.json({success:true,data:lead});});

/* Status/search */
app.get("/api/messages/status",(req,res)=>{
  let messages=[...db.messages];
  if(req.query.phone)messages=messages.filter(m=>cleanPhone(m.wa_id)===cleanPhone(req.query.phone));
  if(req.query.from)messages=messages.filter(m=>new Date(m.timestamp)>=new Date(`${req.query.from}T00:00:00`));
  if(req.query.to)messages=messages.filter(m=>new Date(m.timestamp)<=new Date(`${req.query.to}T23:59:59`));
  messages.sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
  res.json({data:messages.slice(0,1000)});
});

/* Media proxy */
app.get("/api/media/:mediaId",async(req,res)=>{
  try{
    const meta=await metaRequest(`/${encodeURIComponent(req.params.mediaId)}`);
    if(!meta?.url) return res.status(404).send("Media URL not available");
    const r=await fetch(meta.url,{headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`}});
    if(!r.ok)return res.status(r.status).send("Media fetch failed");
    res.setHeader("Content-Type",r.headers.get("content-type")||"application/octet-stream");
    const buf=Buffer.from(await r.arrayBuffer());res.send(buf);
  }catch(e){res.status(e.status||500).send(e.message);}
});

/* Webhook */
app.get("/webhook",(req,res)=>{
  const mode=req.query["hub.mode"],token=req.query["hub.verify_token"],challenge=req.query["hub.challenge"];
  if(mode==="subscribe"&&token===VERIFY_TOKEN)return res.status(200).send(challenge);
  return res.sendStatus(403);
});
app.post("/webhook",(req,res)=>{
  res.sendStatus(200);
  try{
    const body=req.body;
    console.log(`[WEBHOOK] ${now()} object=${body?.object||"unknown"}`);
    if(body?.object!=="whatsapp_business_account")return;
    (body.entry||[]).forEach(entry=>(entry.changes||[]).forEach(change=>{
      const value=change.value||{};
      console.log(`[WEBHOOK CHANGE] field=${change.field||""} messages=${(value.messages||[]).length} statuses=${(value.statuses||[]).length}`);
      (value.messages||[]).forEach(m=>{ console.log(`[WEBHOOK INCOMING] from=${String(m.from||"").slice(-4)} type=${m.type} id=${m.id}`); handleIncomingMessage(m,value); });
      (value.statuses||[]).forEach(s=>{ console.log(`[WEBHOOK STATUS] wamid=${s.id} status=${s.status} recipient=${String(s.recipient_id||"").slice(-4)}`); handleStatusUpdate(s); });
    }));
  }catch(e){console.error("Webhook processing error:",e);}
});
function handleIncomingMessage(message,value){
  const phone=cleanPhone(message.from);if(!phone)return;
  const profileName=value?.contacts?.find(c=>cleanPhone(c.wa_id)===phone)?.profile?.name;
  const contact=upsertContact({phone,wa_id:phone,name:profileName||"WhatsApp Contact"});
  const conversation=getConversation(phone);
  let text="";let media=null;
  if(message.type==="text")text=message.text?.body||"";
  else if(message.type==="button")text=message.button?.text||"";
  else if(message.type==="interactive")text=message.interactive?.button_reply?.title||message.interactive?.list_reply?.title||"";
  else if(["image","video","audio","document","sticker"].includes(message.type)){
    media={id:message[message.type]?.id||null,mime_type:message[message.type]?.mime_type||"",caption:message[message.type]?.caption||""};
    text=media.caption||`[${message.type}]`;
  } else text=`[${message.type||"message"}]`;
  const timestamp=message.timestamp?new Date(Number(message.timestamp)*1000).toISOString():now();
  db.messages.push({id:makeId("msg"),wamid:message.id,wa_id:phone,direction:"inbound",type:message.type||"unknown",text,media,raw:message,status:"received",timestamp});
  conversation.unread=Number(conversation.unread||0)+1;conversation.lastIncomingAt=timestamp;conversation.lastMessageAt=timestamp;conversation.lastMessage=text;conversation.lastDirection="inbound";
  const lead=leadForPhone(phone);
  const lower=text.toLowerCase();
  if(/^(stop|remove|unsubscribe|not interested|no thanks)\b/.test(lower)||lower.includes("not interested")){
    if(lead){lead.optOut=true;setLeadStage(lead,STAGES.JUNK,"customer_opt_out");}
  } else if(media&&["image","video"].includes(message.type)){
    if(lead)setLeadStage(lead,STAGES.PHOTO_RECEIVED,"photo_received");
  }
  saveDatabase();addEvent("incoming_message",{wa_id:phone,type:message.type,mediaId:media?.id||null});
}
function handleStatusUpdate(status){
  const message=db.messages.find(m=>m.wamid===status.id);
  if(message){
    applyStatusToMessage(message,status);
    db.campaigns.forEach(c=>{const r=c.results.find(x=>x.messageId===status.id);if(r){r.status=status.status;if(status.status==="failed")r.error=status.errors||[];}});
  } else if(status?.id){
    db.pendingStatuses[status.id]={id:status.id,status:status.status,timestamp:status.timestamp||null,recipient_id:status.recipient_id||null,errors:status.errors||[]};
    console.log(`[WEBHOOK STATUS] queued pending status for wamid=${status.id}`);
  }
  saveDatabase();addEvent("message_status",{wamid:status.id,status:status.status,recipient:status.recipient_id});
}

/* Dashboard */
app.get("/api/dashboard/stats",(req,res)=>{
  processLeadTimers();
  const totalContacts=db.contacts.length,totalMessages=db.messages.length,inbound=db.messages.filter(m=>m.direction==="inbound").length,outbound=db.messages.filter(m=>m.direction==="outbound").length,unread=Object.values(db.conversations).reduce((s,c)=>s+Number(c.unread||0),0);
  const leadStats={};Object.values(STAGES).forEach(s=>leadStats[s]=db.leads.filter(l=>l.stage===s).length);
  const contacted=db.leads.filter(l=>l.contactedAt).length;
  res.json({totalContacts,totalMessages,inbound,outbound,unread,activeCampaigns:db.campaigns.filter(c=>c.status==="running").length,templates:db.templates.length,leadStats,contacted,percentages:Object.fromEntries(Object.entries(leadStats).map(([k,v])=>[k,contacted?Number((v/contacted*100).toFixed(1)):0]))});
});
app.get("/api/events",(req,res)=>res.json({data:db.events.slice(0,200)}));
app.get("/api/settings/followups",(req,res)=>res.json({data:db.settings}));
app.post("/api/settings/followups",(req,res)=>{const s=req.body||{};db.settings.followup1Days=Math.max(1,Number(s.followup1Days)||1);db.settings.followup2Days=Math.max(1,Number(s.followup2Days)||3);saveDatabase();res.json({success:true,data:db.settings});});

/* Connected numbers UI */
app.get("/api/numbers",(req,res)=>res.json({data:db.connectedNumbers,active:process.env.CONNECTED_WHATSAPP_NUMBER||""}));
app.post("/api/numbers",(req,res)=>{const {number,label}=req.body||{};if(!number)return res.status(400).json({error:"Number is required"});const item={id:makeId("number"),number:String(number),label:String(label||"WhatsApp Number"),createdAt:now()};db.connectedNumbers.push(item);saveDatabase();res.json({success:true,data:item});});

/* Root */
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

async function startServer() {
  db = await loadDatabase();
  appReady = true;
  app.listen(PORT,"0.0.0.0",()=>{
    console.log(`Royal Hair WhatsApp Dashboard running on port ${PORT}`);
    console.log(`Persistence: ${pgPool ? "PostgreSQL" : "local JSON fallback"}`);
    resumeRunningCampaigns();
  });
}

startServer().catch(error=>{
  console.error("Fatal startup error:", error);
  process.exit(1);
});
