import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static("./"));

// Читаем переменные окружения и убираем случайные пробелы
const REPLICATE_TOKEN = (process.env.REPLICATE_TOKEN || "").trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();

const upload = multer({ storage: multer.memoryStorage() });

// Проверка состояния сервера (открывается в браузере)
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    replicate: REPLICATE_TOKEN ? "set" : "MISSING",
    groq: GROQ_API_KEY ? "set" : "MISSING",
  });
});

async function createReplicate(model, input) {
  if (!REPLICATE_TOKEN) throw new Error("REPLICATE_TOKEN не задан в Environment Variables на Render");
  const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || JSON.stringify(data).slice(0, 200));
  return data;
}

// Чат
app.post("/api/chat", async (req, res) => {
  const { provider, model, messages } = req.body;
  try {
    if (provider === "groq") {
      if (!GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY не задан в Environment Variables на Render");
      }

      // Автоматически подменяем устаревшие модели на актуальные
      let activeModel = model;
      const deprecated = [
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant",
        "llama-3.1-70b-versatile",
      ];
      if (!model || deprecated.includes(model)) {
        activeModel = "openai/gpt-oss-120b";
      }

      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: activeModel, messages, temperature: 0.8 }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || `Groq error ${r.status}`);
      return res.json({ reply: data.choices[0].message.content });
    }

    if (provider === "replicate") {
      const prompt =
        messages
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
          .join("\n") + "\nAssistant:";
      const pred = await createReplicate(model, { prompt, max_tokens: 1024 });
      return res.json({ id: pred.id });
    }

    throw new Error("Неизвестный провайдер: " + provider);
  } catch (e) {
    console.error("Chat error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Генерация фото/видео
app.post("/api/generate", async (req, res) => {
  const { model, prompt, type } = req.body;
  try {
    let input = { prompt };
    if (type === "image") {
      input = {
        ...input,
        negative_prompt: "blurry, low quality",
        disable_safety_checker: true,
        width: 1024,
        height: 1024,
      };
    } else if (type === "video") {
      input = { ...input, num_frames: 24, fps: 8 };
    }
    const pred = await createReplicate(model, input);
    res.json({ id: pred.id });
  } catch (e) {
    console.error("Generate error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Анализ фото (Vision)
app.post("/api/vision", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Файл не загружен");
    const base64 = req.file.buffer.toString("base64");
    const dataUri = `data:${req.file.mimetype};base64,${base64}`;
    const pred = await createReplicate("yorickvp/llava-13b", {
      image: dataUri,
      prompt: "Describe this image in detail.",
      max_tokens: 500,
    });
    res.json({ id: pred.id });
  } catch (e) {
    console.error("Vision error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Проверка статуса задачи
app.get("/api/poll/:id", async (req, res) => {
  try {
    const r = await fetch(`https://api.replicate.com/v1/predictions/${req.params.id}`, {
      headers: { Authorization: `Token ${REPLICATE_TOKEN}` },
    });
    const data = await r.json();

    if (data.status === "succeeded") {
      let out = data.output;
      if (Array.isArray(out)) out = out.join("");
      return res.json({ status: "succeeded", url: data.output, text: out });
    }
    if (data.status === "failed") {
      return res.json({ status: "failed", error: data.error });
    }
    res.json({ status: data.status });
  } catch (e) {
    console.error("Poll error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));