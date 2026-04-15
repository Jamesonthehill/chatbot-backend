import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const port = process.env.PORT || 3000;

// ✅ CORS: allow your website origins (add/remove as needed)
const ALLOWED_ORIGINS = [
  "https://jamesonthehill.com",
  "https://jamesonthehill.github.io",
  "http://localhost:8000",
  "http://localhost:5173",
];

app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // allow curl/postman
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error("CORS blocked: " + origin), false);
      },
      methods: ["POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
    })
);

app.options("*", cors()); // ✅ handle preflight
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// (optional) health check
app.get("/", (req, res) => res.send("OK"));

app.post("/api/chat", async (req, res) => {
  try {
    // ✅ Support BOTH payload styles:
    // 1) { message: "hi" }              (your old index.html)
    // 2) { messages: [{role,content}] } (your React widget)
    let messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const single = typeof req.body.message === "string" ? req.body.message : "";

    // If only {message} was provided, convert to messages format
    if (messages.length === 0 && single.trim()) {
      messages = [{ role: "user", content: single.trim() }];
    }

    // Build transcript for multi-turn context
    const transcript = messages
        .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
        .join("\n");

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input:
          `You are a helpful chatbot for my website. Answer clearly.\n\n` +
          transcript +
          `\nAssistant:`,
    });
    // List threads (optional)
    app.get("/api/chat/threads", async (req, res) => {
      const { rows } = await pool.query(
          "SELECT id, created_at FROM chat_threads ORDER BY created_at DESC LIMIT 50"
      );
      res.json({ threads: rows });
    });

// Get messages of one thread (optional)
    app.get("/api/chat/threads/:id/messages", async (req, res) => {
      const { id } = req.params;
      const { rows } = await pool.query(
          "SELECT role, content, created_at FROM chat_messages WHERE thread_id=$1 ORDER BY created_at ASC",
          [id]
      );
      res.json({ messages: rows });
    });
    const replyText = response.output?.[0]?.content?.[0]?.text ?? "";

    res.json({ reply: replyText || "(empty)" });
  } catch (err) {
    console.error("Error from /api/chat:", err);
    res.status(500).json({ reply: null, error: err?.message ?? String(err) });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
