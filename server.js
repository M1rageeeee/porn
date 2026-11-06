import express from "express";
import cors from "cors";
import multer from "multer";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(".")); // Раздает index.html

const upload = multer({ storage: multer.memoryStorage() });

// Создание задачи в Replicate
async function createReplicate(model, input) {
  const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.REPLICATE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Ошибка Replicate API");
  return data;
}

// 1. Чат (Groq или Replicate)
app.post("/api/chat", async (req, res) => {
  const { provider, model, messages } = req.body;
  try {
    if (provider === "groq") {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages, temperature: 0.8 }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || "Ошибка Groq");
      return res.json({ reply: data.choices[0].message.content });
    }

    if (provider === "replicate") {
      // Собираем историю сообщений в один промпт для LLM на Replicate
      const prompt = messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join("\n") + "\nAssistant:";
      const pred = await createReplicate(model, { prompt, max_tokens: 1024 });
      return res.json({ id: pred.id }); // Возвращаем ID, фронтенд будет опрашивать статус
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. Генерация фото и видео (Replicate)
app.post("/api/generate", async (req, res) => {
  const { model, prompt, type } = req.body;
  try {
    let input = { prompt };
    if (type === "image") {
      input = { ...input, negative_prompt: "blurry, low quality", disable_safety_checker: true, width: 1024, height: 1024 };
    } else if (type === "video") {
      input = { ...input, num_frames: 24, fps: 8 };
    }
    const pred = await createReplicate(model, input);
    res.json({ id: pred.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Анализ фото (Vision)
app.post("/api/vision", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Файл не загружен");
    const base64 = req.file.buffer.toString("base64");
    const dataUri = `data:${req.file.mimetype};base64,${base64}`;
    const pred = await createReplicate("yorickvp/llava-13b", { 
      image: dataUri, 
      prompt: "Describe this image in detail in Russian.", 
      max_tokens: 500 
    });
    res.json({ id: pred.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. Проверка статуса задачи (Polling)
app.get("/api/poll/:id", async (req, res) => {
  try {
    const r = await fetch(`https://api.replicate.com/v1/predictions/${req.params.id}`, {
      headers: { Authorization: `Token ${process.env.REPLICATE_TOKEN}` },
    });
    const data = await r.json();
    
    if (data.status === "succeeded") {
      let out = data.output;
      if (Array.isArray(out)) out = out.join(""); // Для текстовых моделей
      return res.json({ status: "succeeded", url: data.output, text: out });
    }
    if (data.status === "failed") return res.json({ status: "failed", error: data.error });
    res.json({ status: data.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));