import express from "express";
import cors from "cors";
import OpenAI from "openai";
import pg from "pg";
import crypto from "crypto";

const app = express();
const port = process.env.PORT || 3000;
const { Pool } = pg;

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL missing");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

console.log("DB host:", new URL(process.env.DATABASE_URL).hostname);

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
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
    })
);

app.options(/.*/, cors()); // ✅ handle preflight
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// (optional) health check
app.get("/", (req, res) => res.send("OK"));

// DB ping endpoint
app.get("/api/db/ping", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT NOW()");
    res.json({ timestamp: rows[0].now });
  } catch (err) {
    console.error("DB ping error:", err);
    res.status(500).json({ error: err.message });
  }
});

// List threads
app.get("/api/chat/threads", async (req, res) => {
  try {
    const { rows } = await pool.query(
        "SELECT id, created_at FROM chat_threads ORDER BY created_at DESC LIMIT 50"
    );
    res.json({ threads: rows });
  } catch (err) {
    console.error("Error fetching threads:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get messages of one thread
app.get("/api/chat/threads/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
        "SELECT role, content, created_at FROM chat_messages WHERE thread_id=$1 ORDER BY created_at ASC",
        [id]
    );
    res.json({ messages: rows });
  } catch (err) {
    console.error("Error fetching messages:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    let { threadId, messages } = req.body;

    // Support old payload style
    if (!messages && req.body.message) {
      messages = [{ role: "user", content: req.body.message }];
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages required" });
    }

    // Generate threadId if not provided
    if (!threadId) {
      threadId = crypto.randomUUID();
    }

    // Check if thread exists
    const threadExists = await pool.query("SELECT id FROM chat_threads WHERE id = $1", [threadId]);
    if (threadExists.rows.length === 0) {
      // Insert new thread
      await pool.query("INSERT INTO chat_threads (id) VALUES ($1)", [threadId]);
      // Insert all messages for new thread
      for (const msg of messages) {
        await pool.query(
          "INSERT INTO chat_messages (id, thread_id, role, content) VALUES ($1, $2, $3, $4)",
          [crypto.randomUUID(), threadId, msg.role, msg.content]
        );
      }
    } else {
      // For existing thread, assume messages include the new user message at the end
      // Insert only the last user message if it's new
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === "user") {
        await pool.query(
          "INSERT INTO chat_messages (id, thread_id, role, content) VALUES ($1, $2, $3, $4)",
          [crypto.randomUUID(), threadId, lastMsg.role, lastMsg.content]
        );
      }
    }


    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful chatbot for my website. Answer clearly." },
        ...messages
      ],
    });

    const replyText = response.choices[0]?.message?.content ?? "";

    // Insert assistant message
    await pool.query(
      "INSERT INTO chat_messages (id, thread_id, role, content) VALUES ($1, $2, $3, $4)",
      [crypto.randomUUID(), threadId, "assistant", replyText]
    );

    res.json({ reply: replyText, threadId });
  } catch (err) {
    console.error("Error from /api/chat:", err);
    res.status(500).json({ reply: null, error: err?.message ?? String(err) });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
