import express from "express";
import cors from "cors";
import OpenAI from "openai";
import pg from "pg";
import { randomUUID } from "crypto";

const app = express();
const port = process.env.PORT || 3000;
const { Pool } = pg;


/* -------------------------------
   CORS (allow your website)
-------------------------------- */
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
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
    })
);

// ✅ preflight (avoid the "*" crash you hit earlier)
app.options(/.*/, cors());
app.use(express.json());

/* -------------------------------
   OpenAI
-------------------------------- */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* -------------------------------
   Postgres (Render)
   Set DATABASE_URL in Render env
-------------------------------- */
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL missing");

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes(".render.com") ? { rejectUnauthorized: false } : undefined,
});

/* -------------------------------
   Health / DB Ping
-------------------------------- */
app.get("/", (req, res) => res.send("OK"));

app.get("/api/db/ping", async (req, res) => {
  const r = await pool.query("SELECT NOW() as now");
  res.json(r.rows[0]);
});

/* -------------------------------
   (Optional) Thread APIs
   Requires tables: chat_threads, chat_messages
-------------------------------- */
app.get("/api/chat/threads", async (req, res) => {
  const { rows } = await pool.query(
      "SELECT id, created_at FROM chat_threads ORDER BY created_at DESC LIMIT 50"
  );
  res.json({ threads: rows });
});

app.get("/api/chat/threads/:id/messages", async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
      "SELECT role, content, created_at FROM chat_messages WHERE thread_id=$1 ORDER BY created_at ASC",
      [id]
  );
  res.json({ messages: rows });
});

/* -------------------------------
   Main chat endpoint
   Supports BOTH payload styles:
   1) { message: "hi" }
   2) { threadId, messages: [{role, content}, ...] }
-------------------------------- */
app.post("/api/chat", async (req, res) => {
  try {
    // payload
    const incomingThreadId = req.body.threadId;
    let messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const single = typeof req.body.message === "string" ? req.body.message : "";

    // normalize messages
    if (messages.length === 0 && single.trim()) {
      messages = [{ role: "user", content: single.trim() }];
    }

    // determine threadId
    const threadId = incomingThreadId || randomUUID();

    // pick the latest user message text
    const lastUser = [...messages].reverse().find((m) => m?.role === "user");
    const userText = (lastUser?.content || "").trim();

    // create thread row if missing
    await pool.query(
        "INSERT INTO chat_threads (id) VALUES ($1) ON CONFLICT DO NOTHING",
        [threadId]
    );

    // save user message (only if non-empty)
    if (userText) {
      await pool.query(
          "INSERT INTO chat_messages (id, thread_id, role, content) VALUES ($1,$2,$3,$4)",
          [randomUUID(), threadId, "user", userText]
      );
    }

    // build transcript for context (client-provided)
    const transcript = messages
        .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
        .join("\n");

    // call OpenAI
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input:
          `You are a helpful chatbot for my website. Answer clearly.\n\n` +
          transcript +
          `\nAssistant:`,
    });

    const replyText = response.output?.[0]?.content?.[0]?.text ?? "";

    // save assistant message
    await pool.query(
        "INSERT INTO chat_messages (id, thread_id, role, content) VALUES ($1,$2,$3,$4)",
        [randomUUID(), threadId, "assistant", replyText || "(empty)"]
    );

    res.json({ threadId, reply: replyText || "(empty)" });
  } catch (err) {
    const msg =
        err?.message ||
        err?.detail ||
        err?.stack ||
        String(err);

    console.error("API /api/chat ERROR:", err);

    res.status(500).json({ reply: null, error: msg });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});