import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const port = process.env.PORT || 3000;

// ✅ CORS (allow your GitHub Pages domain)
app.use(cors({
  origin: ["https://jamesonthehill.com", "http://localhost:5173", "http://localhost:3000"],
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/chat", async (req, res) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    // messages: [{ role: "user"|"assistant", content: "..." }, ...]

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are a helpful chatbot for my website. Answer briefly and clearly." },
        ...messages,
      ],
    });

    const reply = completion.choices?.[0]?.message?.content ?? "";
    res.json({ reply });
  } catch (err) {
    console.error("Error from /api/chat:", err);
    res.status(500).json({ reply: null, error: err?.message || "server error" });
  }
});

app.listen(port, () => console.log(`Server listening on ${port}`));
