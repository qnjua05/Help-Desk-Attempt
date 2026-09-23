// POST /api/triage -> AI triage (requires the ANTHROPIC_API_KEY app setting)
const { app } = require("@azure/functions");
const { CATEGORIES, PRIORITIES, json, readJson, handle } = require("../lib/shared");

app.http("triage", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "triage",
  handler: handle(async (request) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return json({ error: "AI triage isn't configured yet — add the ANTHROPIC_API_KEY app setting." }, 501);
    }
    const t = await readJson(request);
    const prompt =
      "You are an IT helpdesk triage assistant. Analyze this ticket and respond with ONLY a raw JSON object, no markdown fences, no preamble. Keys: " +
      '"category" (exactly one of ' + JSON.stringify(CATEGORIES) + "), " +
      '"priority" (exactly one of ' + JSON.stringify(PRIORITIES) + "), " +
      '"reasoning" (one short sentence), ' +
      '"firstResponse" (a professional 2-4 sentence first reply to the requester).' +
      "\n\nSubject: " + (t.subject || "") +
      "\nDescription: " + (t.description || "(none)") +
      "\nCurrent category: " + (t.category || "") +
      "\nCurrent priority: " + (t.priority || "");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    const text = (data.content || [])
      .filter((blk) => blk.type === "text")
      .map((blk) => blk.text)
      .join("\n");
    try {
      return json(JSON.parse(text.replace(/```json|```/g, "").trim()));
    } catch {
      return json({ error: "Triage returned an unexpected format — try again." }, 502);
    }
  }),
});
