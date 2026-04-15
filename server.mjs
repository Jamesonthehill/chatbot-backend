import express from "express";
import cors from "cors";
import OpenAI from "openai";
import pg from "pg";
import { randomUUID } from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
      ? { rejectUnauthorized: false }
      : undefined,
});

const ALLOWED_ORIGINS = [
  "https://jamesonthehill.com",
  "https://jamesonthehill.github.io",
  "http://localhost:8000",
  "http://localhost:5173",
];

app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error("CORS blocked: " + origin), false);
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
    })
);

app.options(/.*/, cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => res.send("OK"));

app.get("/api/db/ping", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT NOW() as now");
    res.json(rows[0]);
  } catch (err) {
    console.error("DB ping error:", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get("/api/chat/threads", async (req, res) => {
  try {
    const { rows } = await pool.query(
        "SELECT id, created_at FROM chat_threads ORDER BY created_at DESC LIMIT 50"
    );
    res.json({ threads: rows });
  } catch (err) {
    console.error("Threads error:", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get("/api/chat/threads/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
        "SELECT role, content, created_at FROM chat_messages WHERE thread_id = $1 ORDER BY created_at ASC",
        [id]
    );
    res.json({ messages: rows });
  } catch (err) {
    console.error("Messages error:", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const incomingThreadId = req.body.threadId;
    let messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const single = typeof req.body.message === "string" ? req.body.message : "";

    if (messages.length === 0 && single.trim()) {
      messages = [{ role: "user", content: single.trim() }];
    }

    const threadId = incomingThreadId || randomUUID();

    const lastUser = [...messages].reverse().find((m) => m?.role === "user");
    const userText = (lastUser?.content || "").trim();

    await pool.query(
        "INSERT INTO chat_threads (id) VALUES ($1) ON CONFLICT DO NOTHING",
        [threadId]
    );

    if (userText) {
      await pool.query(
          "INSERT INTO chat_messages (id, thread_id, role, content) VALUES ($1, $2, $3, $4)",
          [randomUUID(), threadId, "user", userText]
      );
    }

    const { rows: historyRows } = await pool.query(
        "SELECT role, content FROM chat_messages WHERE thread_id = $1 ORDER BY created_at ASC",
        [threadId]
    );

    const transcript = historyRows
        .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
        .join("\n");

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input:
          `You are a helpful chatbot for my website. Answer clearly.\n\n` +
          transcript +
          `\nAssistant:`,
    });

    const replyText = response.output_text || "(empty)";

    await pool.query(
        "INSERT INTO chat_messages (id, thread_id, role, content) VALUES ($1, $2, $3, $4)",
        [randomUUID(), threadId, "assistant", replyText]
    );

    res.json({ threadId, reply: replyText });
  } catch (err) {
    console.error("Error from /api/chat:", err);
    res.status(500).json({ reply: null, error: err?.message ?? String(err) });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});