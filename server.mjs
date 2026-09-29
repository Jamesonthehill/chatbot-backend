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
  ssl: { rejectUnauthorized: false },
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let scheduleTablePromise;

function ensureScheduleTable() {
  if (!scheduleTablePromise) {
    scheduleTablePromise = pool.query(`
      CREATE TABLE IF NOT EXISTS portfolio_schedules (
        owner_id UUID PRIMARY KEY,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
  return scheduleTablePromise;
}

function validScheduleState(value) {
  return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray(value.tasks) &&
      value.tasks.length <= 500 &&
      value.situation &&
      typeof value.situation === "object"
  );
}

app.get("/", (req, res) => res.send("OK"));

console.log("Before inserting user message");
app.get("/api/db/ping", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT NOW() as now");
    res.json(rows[0]);
  } catch (err) {
    console.error("DB ping FULL ERROR:", err);

    res.status(500).json({
      error:
          err?.stack ||
          err?.message ||
          err?.detail ||
          String(err) ||
          "Unknown DB error",
    });
  }
});

app.get("/api/debug/db-host", (req, res) => {
  try {
    const url = process.env.DATABASE_URL;

    if (!url) {
      return res.json({
        hasDatabaseUrl: false,
      });
    }

    const parsed = new URL(url);

    res.json({
      hasDatabaseUrl: true,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || "5432",
      pathname: parsed.pathname,
    });
  } catch (err) {
    res.status(500).json({
      error: err?.stack || err?.message || String(err),
    });
  }
});

app.get("/api/schedule/:ownerId", async (req, res) => {
  try {
    const { ownerId } = req.params;
    if (!UUID_PATTERN.test(ownerId)) {
      return res.status(400).json({ error: "Invalid schedule ID" });
    }

    await ensureScheduleTable();
    const { rows } = await pool.query(
        "SELECT state, updated_at FROM portfolio_schedules WHERE owner_id = $1",
        [ownerId]
    );
    res.json(rows[0] || { state: null, updated_at: null });
  } catch (err) {
    console.error("Schedule load error:", err);
    res.status(500).json({ error: "Unable to load schedule" });
  }
});

app.post("/api/schedule/:ownerId", async (req, res) => {
  try {
    const { ownerId } = req.params;
    const { state } = req.body || {};
    if (!UUID_PATTERN.test(ownerId)) {
      return res.status(400).json({ error: "Invalid schedule ID" });
    }
    if (!validScheduleState(state)) {
      return res.status(400).json({ error: "Invalid schedule data" });
    }

    await ensureScheduleTable();
    const { rows } = await pool.query(
        `INSERT INTO portfolio_schedules (owner_id, state, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (owner_id)
         DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
         RETURNING updated_at`,
        [ownerId, JSON.stringify(state)]
    );
    res.json({ saved: true, updated_at: rows[0].updated_at });
  } catch (err) {
    console.error("Schedule save error:", err);
    res.status(500).json({ error: "Unable to save schedule" });
  }
});

console.log("Before loading history");
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
console.log("Before inserting assistant message");
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
console.log("Before calling OpenAI");
app.post("/api/chat", async (req, res) => {
  try {
    const incomingThreadId = req.body.threadId;
    let messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const single = typeof req.body.message === "string" ? req.body.message : "";

    if (messages.length === 0 && single.trim()) {
      messages = [{role: "user", content: single.trim()}];
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

    const {rows: historyRows} = await pool.query(
        "SELECT role, content FROM chat_messages WHERE thread_id = $1 ORDER BY created_at ASC",
        [threadId]
    );

    const transcript = historyRows
        .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
        .join("\n");

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions: `
    You are Geonwoo Lee's resume assistant.
    
    You answer questions for employers, recruiters, and portfolio visitors.
    Use only Geonwoo's resume as your source of truth.
    If the resume does not mention the answer, say:
    "Geonwoo's resume does not mention that."
    
    Do not invent experience, skills, dates, companies, or projects.
    Keep answers professional and concise.
      `,
      input:
          `Conversation so far:\n${transcript}\n\n` +
          `Current question:\n${userText}`,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [process.env.RESUME_VECTOR_STORE_ID],
          max_num_results: 8,
        },
      ],
    });

    const replyText = response.output_text || "(empty)";
    console.log("Before inserting thread");
    await pool.query(
        "INSERT INTO chat_messages (id, thread_id, role, content) VALUES ($1, $2, $3, $4)",
        [randomUUID(), threadId, "assistant", replyText]
    );

    res.json({threadId, reply: replyText});
  } catch (err) {
    console.error("Error from /api/chat FULL:", err);

    const errorMessage =
        err?.stack ||
        err?.message ||
        err?.detail ||
        JSON.stringify(err, null, 2) ||
        String(err);

    res.status(500).json({
      reply: null,
      error: errorMessage,
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
