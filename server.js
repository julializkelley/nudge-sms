import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ─── Paid users whitelist ────────────────────────────────────────────────────
// Add phone numbers in E.164 format after someone pays: "+14155551234"
const PAID_USERS = new Set([
  // "+14155551234",
]);

// ─── Conversation memory (in-process, resets on redeploy) ────────────────────
// For persistence across deploys, swap this out for Airtable or a free DB later
const conversations = {};

// ─── Coach system prompt ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Nudge, a warm but direct AI accountability coach delivered entirely via SMS.

Your personality:
- Encouraging but honest — you don't let people off the hook easily
- Concise — this is SMS, not email. Keep responses under 3 sentences unless they share a lot
- Personal — remember what users tell you about their goals within the conversation
- Proactive — ask one focused follow-up question to understand their goals or progress
- Never preachy — coach, don't lecture

Your job:
- Help users clarify and commit to specific goals
- Check in on progress when they text you
- Gently challenge excuses and help them problem-solve
- Celebrate wins (briefly)

First message from a new user: Warmly introduce yourself, ask what ONE goal they want to focus on this week.

Always end with either a question or a concrete next step for them to confirm.`;

// ─── Incoming SMS handler ─────────────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();

  const twiml = new twilio.twiml.MessagingResponse();

  // Check if this number has paid
  if (!PAID_USERS.has(from)) {
    twiml.message(
      "Hey! To chat with your Nudge accountability coach, grab a subscription at [YOUR_SITE_URL]. It's $5/month. Text back once you're set up!"
    );
    return res.type("text/xml").send(twiml.toString());
  }

  // Initialize conversation history for new users
  if (!conversations[from]) {
    conversations[from] = [];
  }

  // Add user message to history
  conversations[from].push({ role: "user", content: body });

  // Keep last 20 messages to stay within context limits
  const recentHistory = conversations[from].slice(-20);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: recentHistory,
    });

    const reply = response.content[0].text;

    // Save assistant reply to history
    conversations[from].push({ role: "assistant", content: reply });

    twiml.message(reply);
  } catch (err) {
    console.error("Anthropic error:", err);
    twiml.message("Something went wrong on my end — try again in a moment!");
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── Admin: add a paid user ───────────────────────────────────────────────────
// Hit this endpoint from Zapier or manually after someone pays on Stripe
// POST /add-user  { "phone": "+14155551234", "secret": "YOUR_ADMIN_SECRET" }
app.post("/add-user", (req, res) => {
  const { phone, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!phone) return res.status(400).json({ error: "Phone required" });
  PAID_USERS.add(phone);
  console.log(`Added paid user: ${phone}`);
  res.json({ success: true, phone, totalUsers: PAID_USERS.size });
});

// ─── Admin: remove a user (cancellation) ─────────────────────────────────────
app.post("/remove-user", (req, res) => {
  const { phone, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  PAID_USERS.delete(phone);
  delete conversations[phone];
  res.json({ success: true });
});

// ─── Landing page: generate goal blueprint ────────────────────────────────────
// Called by the dream input on the landing page — no auth required
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.post("/generate-plan", async (req, res) => {
  const { goal } = req.body;
  if (!goal || goal.trim().length < 3) {
    return res.status(400).json({ error: "Please provide a goal." });
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: `You help someone take the first real step toward a meaningful goal.
Respond ONLY with a valid JSON object — no markdown, no backticks, no explanation. Shape:
{
  "steps": [
    { "title": "short bold title", "detail": "one sentence of concrete, specific advice" },
    { "title": "...", "detail": "..." },
    { "title": "...", "detail": "..." },
    { "title": "...", "detail": "..." }
  ],
  "hook": "2 sentences. First: acknowledge how hard it is to stay consistent without someone in your corner. Second: explain that Nudge texts them, remembers this exact goal, and holds them to it — so they actually become who they said they'd be."
}
Steps must be grounded, specific, immediately actionable. No fluff. No clichés.`,
      messages: [{ role: "user", content: `My goal: ${goal.trim()}` }],
    });

    const raw = response.content[0].text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (err) {
    console.error("generate-plan error:", err);
    res.status(500).json({ error: "Could not generate plan. Try again." });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Nudge is running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nudge server running on port ${PORT}`));
