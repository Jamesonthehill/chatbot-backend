import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message ?? "";

    // Use simple string input (easier & safe)
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: `You are a helpful chatbot for my website. Answer briefly and clearly.\nUser: ${userMessage}`,
    });

    const replyText = response.output[0]?.content[0]?.text ?? "";

    res.json({ reply: replyText });
  } catch (err) {
    console.error("Error from /api/chat:", err);
    res.status(500).json({ reply: null, error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
