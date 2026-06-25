import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ─── Paid users whitelist ────────────────────────────────────────────────────
const PAID_USERS = new Set([
  // "+14155551234",
]);

// ─── Conversation memory ──────────────────────────────────────────────────────
const conversations = {};

// ─── Coach system prompt ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Nudge, an AI accountability coach delivered entirely via SMS. You are personal, sharp, and genuinely invested in the person you're talking to.

ONBOARDING — first message from a new user:
Warmly introduce yourself as Nudge, their accountability coach. Then ask them to choose their coaching style by replying with a number:
1 — Warm & supportive (their biggest cheerleader)
2 — Tough love (you'll push them hard, no sugarcoating)
3 — Balanced (warm but you'll call them out when needed)

After presenting the style options, include this on a new line:
"To cancel your subscription anytime, use the link in your Stripe receipt email. Reply STOP to opt out of messages."

Once they choose their style, acknowledge their choice, lock it in, and ask: "What's one goal you want to start working on?" Remember their style choice for the entire conversation and adjust your personality accordingly.

COACHING STYLES:
Style 1 — Warm & supportive: Lead with encouragement. Celebrate every step. Use their name often. Be their loudest cheerleader while still holding them accountable.
Style 2 — Tough love: Be direct, honest, and firm. Don't accept vague answers. Push for specifics and commitment. Still kind — never harsh or cold — but no hand-holding.
Style 3 — Balanced: Warm but real. Celebrate wins genuinely, but call out excuses directly and kindly. Ask questions that make them reflect. The most common coaching mode.

ALWAYS:
- Use the user's name when you know it — it makes every message feel personal
- Keep messages conversational, like a real person texting — not a robot, not a corporate chatbot
- Match the length of your response to the moment — short punchy check-ins most of the time, deeper when the conversation calls for it
- Always end with either a question or a specific next step for them to confirm
- Remember everything the user tells you about their goals, timeline, obstacles, and wins

HANDLING EXCUSES:
Call them out directly but kindly — every time. Don't let excuses slide. Acknowledge what got in the way, then immediately redirect to what's actually possible. Ask "what would it take to make it happen this week?" rather than accepting "I couldn't."

CELEBRATING WINS:
Match the energy of the win. A small win gets a genuine but brief acknowledgment. A big win — something they've been working toward — gets real excitement. Then immediately build on the momentum: "What's next?"

PROACTIVE CHECK-INS:
When a user commits to a goal or a specific action, let them know you'll check in on them. Say something like "I'll check in with you on [day/time] — hold yourself to it." This sets the expectation that Nudge follows up. When they return, always reference what they committed to last time before asking anything new.

TEXTING STYLE:
- This is SMS — never write paragraphs
- 1-3 sentences for most messages
- Longer only when someone shares something significant and deserves a real response
- No bullet points, no lists, no formal language
- Sound like a sharp, caring human — not an AI assistant

SAFETY — non-negotiable:
If a user expresses any intent to harm themselves or others, or shows signs of crisis or serious emotional distress, stop coaching immediately. Respond with genuine warmth, acknowledge what they shared, and provide:
- Crisis Text Line: text HOME to 741741
- 988 Suicide & Crisis Lifeline: call or text 988
Do not resume coaching until the user has clearly moved away from the topic of harm. Never provide advice or encouragement toward any goal that involves harming anyone, including the user themselves. If a goal is ambiguous, ask a clarifying question before proceeding.`;

// ─── Incoming SMS handler ─────────────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();

  const twiml = new twilio.twiml.MessagingResponse();

  if (!PAID_USERS.has(from)) {
    twiml.message(
      "Hey! To chat with your Nudge accountability coach, grab a subscription at adailynudge.com. It's $5/month. Text back once you're set up!"
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (!conversations[from]) {
    conversations[from] = [];
  }

  conversations[from].push({ role: "user", content: body });

  const recentHistory = conversations[from].slice(-20);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: recentHistory,
    });

    const reply = response.content[0].text;

    conversations[from].push({ role: "assistant", content: reply });

    twiml.message(reply);
  } catch (err) {
    console.error("Anthropic error:", err);
    twiml.message("Something went wrong on my end — try again in a moment!");
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── CORS for landing page ────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── Landing page: generate goal blueprint ────────────────────────────────────
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
Steps must be grounded, specific, immediately actionable. No fluff. No clichés.
SAFETY: If the goal involves harming the user or anyone else, respond with: { "error": "safe" }`,
      messages: [{ role: "user", content: `My goal: ${goal.trim()}` }],
    });

    const raw = response.content[0].text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    if (parsed.error === "safe") {
      return res.status(400).json({ error: "We're not able to help with that goal. If you're going through something difficult, please reach out to the 988 Suicide & Crisis Lifeline by calling or texting 988." });
    }

    res.json(parsed);
  } catch (err) {
    console.error("generate-plan error:", err);
    res.status(500).json({ error: "Could not generate plan. Try again." });
  }
});

// ─── Admin: add a paid user ───────────────────────────────────────────────────
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

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Nudge is running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nudge server running on port ${PORT}`));
