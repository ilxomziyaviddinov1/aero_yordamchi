// ============================================================
// Telegram Business uchun AI avto-javob beruvchi bot
// Stack: Node.js (ES Module) + grammY + @google/genai (Gemini)
// ============================================================

import "dotenv/config"; // .env faylini yuklaydi
import { createServer } from "node:http";
import { Bot } from "grammy";
import { GoogleGenAI } from "@google/genai";

// ---------- 1. Muhit o'zgaruvchilarini tekshirish ----------
const { BOT_TOKEN, GEMINI_API_KEY } = process.env;

if (!BOT_TOKEN || !GEMINI_API_KEY) {
  console.error(
    "❌ Xato: .env faylida BOT_TOKEN va GEMINI_API_KEY to'ldirilishi shart."
  );
  process.exit(1);
}

// ---------- 2. Sozlamalar ----------
const MODEL = "gemini-2.5-flash";

// ⚠️ SHU BLOKNI O'ZINGIZGA MOSLAB TO'LDIRING — bot shu ma'lumotlar asosida "siz kabi" gapiradi.
const OWNER_PROFILE = {
  name: "Ilxom", // sizning ismingiz
  about: "Bu yerga nima bilan shug'ullanishingizni yozing (masalan: aviachiptalar bo'yicha maslahatchi).",
  // Sizning haqiqiy yozish uslubingizdan 4-8 ta namuna. Qanchalik real bo'lsa, shunchalik yaxshi.
  styleSamples: [
    "Assalomu alaykum, aka! Xa, eshityapman, gapiring.",
    "Xop, hozir tekshirib ko'raman, 5 daqiqadan keyin yozaman.",
    "Zo'r, rahmat! Yana savol bo'lsa bemalol yozing.",
  ],
  // Bot bilmaydigan/va'da qila olmaydigan narsalar
  facts: "Narxlar, band qilish va shaxsiy masalalar bo'yicha aniq ma'lumot bo'lmasa, o'zingdan to'qima.",
};

const SYSTEM_INSTRUCTION = `
Sen ${OWNER_PROFILE.name}ning Telegramdagi yordamchisisan va uning nomidan mijozlar bilan yozishasan.
Vazifang: xuddi ${OWNER_PROFILE.name} o'zi yozayotgandek, tirik odamdek, samimiy va do'stona muloqot qilish.

Kim haqida: ${OWNER_PROFILE.about}

USLUB:
- O'zbek tilida, oddiy so'zlashuv uslubida yoz. Rasmiy, quruq va kitobiy iboralardan qoch.
- Qisqa yoz: odatda 1-3 gap. Odamlar chatda uzun insho yozmaydi.
- Suhbatdoshning ohangiga moslash: u "sen" desa, sen ham "sen" de; "siz" desa, "siz" de. Noma'lum bo'lsa, hurmatli lekin iliq "siz" ishlat.
- Salomga salom bilan, rahmatga "arzimaydi" kabi tabiiy javob ber. Kerak joyda kamdan-kam emoji ishlat (har xabarda emas).
- Har xabar oxirida "yana yordam kerakmi?" kabi shablon gaplarni takrorlama.
- Robotdek bir xil qolipda yozma, javoblaringni o'zgartirib tur.

${OWNER_PROFILE.name}ning yozish uslubi namunalari (shunga o'xshab yoz, lekin so'zma-so'z ko'chirma):
${OWNER_PROFILE.styleSamples.map((t) => "- " + t).join("\n")}

QOIDALAR:
- ${OWNER_PROFILE.facts}
- Bilmagan narsangni to'qima. Narx, muddat, va'da yoki shaxsiy masalalar bo'lsa, "hozir aniq aytolmayman, ${OWNER_PROFILE.name} tez orada o'zi javob beradi" degan ma'noda tabiiy ayt.
- Agar suhbatdosh jiddiy so'rasa: "Sen botmisan / odammisan / AI misan?", yolg'on gapirma. Do'stona ochiq ayt: sen ${OWNER_PROFILE.name}ning AI yordamchisisan, u o'zi ham tez orada ko'radi.
- Haqorat yoki tajovuzkor xabarlarga xotirjam, qisqa javob ber.
`.trim();

const TIMEZONE = "Asia/Tashkent";

/** Har so'rovda joriy Toshkent vaqti bilan yangilangan system instruction. */
function buildSystemInstruction() {
  const now = new Intl.DateTimeFormat("uz-UZ", {
    timeZone: TIMEZONE,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());

  return (
    SYSTEM_INSTRUCTION +
    `\n\nJoriy sana va vaqt (Toshkent): ${now}.` +
    "\nVaqt yoki sana so'ralsa, faqat shu ma'lumotdan foydalaning." +
    "\nValyuta kursi, yangiliklar kabi dolzarb ma'lumotlar so'ralsa, qidiruv vositasidan foydalaning." +
    "\nOddiy matn bilan yozing: **, #, ` kabi Markdown belgilarini ishlatmang."
  );
}

const FALLBACK_REPLY =
  "Kechirasiz, hozir javob bera olmadim. Hisob egasi tez orada siz bilan bog'lanadi.";

const MAX_HISTORY_TURNS = 10; // har bir chat uchun eslab qolinadigan xabarlar soni

// ---------- 3. Klientlarni yaratish ----------
const bot = new Bot(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Suhbat tarixi: chatKey -> [{ role: "user" | "model", parts: [{ text }] }]
const histories = new Map();

// Business ulanishi egasi: business_connection_id -> owner user id
const connectionOwners = new Map();

// ---------- 4. Yordamchi funksiyalar ----------

/** Business akkaunt egasining ID sini aniqlaydi (kesh bilan). */
async function getOwnerId(ctx) {
  const connId = ctx.businessConnectionId;
  if (!connId) return null;

  if (connectionOwners.has(connId)) return connectionOwners.get(connId);

  try {
    const connection = await ctx.getBusinessConnection();
    connectionOwners.set(connId, connection.user.id);
    return connection.user.id;
  } catch (err) {
    console.warn("⚠️ Business ulanish ma'lumotini olib bo'lmadi:", err.message);
    return null;
  }
}

/** Tarixga xabar qo'shadi va uzunlikni cheklaydi. */
function pushHistory(key, role, text) {
  const history = histories.get(key) ?? [];
  history.push({ role, parts: [{ text }] });
  while (history.length > MAX_HISTORY_TURNS) history.shift();
  histories.set(key, history);
  return history;
}

/** Gemini'dan javob oladi. */
async function askGemini(chatKey, userText) {
  const contents = pushHistory(chatKey, "user", userText);

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: buildSystemInstruction(),
      temperature: 0.9,
      tools: [{ googleSearch: {} }], // dolzarb ma'lumotlar uchun Google qidiruvi
    },
  });

  const answer = response.text?.trim();
  if (!answer) throw new Error("Gemini bo'sh javob qaytardi");

  pushHistory(chatKey, "model", answer);
  return answer;
}

// ---------- 5. Business ulanishi hodisasi ----------
bot.on("business_connection", (ctx) => {
  const c = ctx.businessConnection;
  console.log(
    `🔗 Business ulanish: ${c.is_enabled ? "yoqildi" : "o'chirildi"} ` +
      `(egasi: @${c.user.username ?? c.user.id}, id: ${c.id})`
  );
  if (c.is_enabled) connectionOwners.set(c.id, c.user.id);
  else connectionOwners.delete(c.id);
});

// ---------- 6. Asosiy: business_message ----------
bot.on("business_message:text", async (ctx) => {
  const connId = ctx.businessConnectionId;
  const chatId = ctx.chat.id;
  const text = ctx.msg.text;

  try {
    // Hisob egasining o'z xabarlariga javob bermaymiz
    const ownerId = await getOwnerId(ctx);
    if (ownerId && ctx.from?.id === ownerId) return;

    console.log(`📩 [${connId}] chat ${chatId}: ${text}`);

    // "yozmoqda..." ko'rsatkichi: odamdek taassurot uchun
    ctx.api
      .sendChatAction(chatId, "typing", { business_connection_id: connId })
      .catch(() => {});

    const chatKey = `${connId}:${chatId}`;
    const answer = await askGemini(chatKey, text);

    // Javob business chatga business_connection_id orqali yuboriladi
    await ctx.reply(answer, { business_connection_id: connId });

    console.log(`✅ Javob yuborildi (chat ${chatId})`);
  } catch (err) {
    console.error(`❌ Xatolik (chat ${chatId}):`, err?.message ?? err);

    // Xatolikda ham mijozga muloyim javob qaytaramiz
    try {
      await ctx.reply(FALLBACK_REPLY, { business_connection_id: connId });
    } catch (replyErr) {
      console.error("❌ Zaxira javobni yuborib bo'lmadi:", replyErr?.message);
    }
  }
});

// Matn bo'lmagan business xabarlar (rasm, ovoz va h.k.)
bot.on("business_message", async (ctx) => {
  try {
    const ownerId = await getOwnerId(ctx);
    if (ownerId && ctx.from?.id === ownerId) return;

    await ctx.reply(
      "Hozircha faqat matnli xabarlarga javob bera olaman. Iltimos, savolingizni yozib yuboring.",
      { business_connection_id: ctx.businessConnectionId }
    );
  } catch (err) {
    console.error("❌ Matn bo'lmagan xabarga javobda xato:", err?.message ?? err);
  }
});

// ---------- 7. Global xatoliklarni ushlash ----------
bot.catch((err) => {
  console.error(
    `❌ Bot xatosi (update ${err.ctx.update.update_id}):`,
    err.error?.message ?? err.error
  );
});

process.on("unhandledRejection", (reason) =>
  console.error("⚠️ Unhandled rejection:", reason)
);

// ---------- 8. (Ixtiyoriy) Health-check server ----------
// Faqat Render "Web Service" sifatida ishlaganda (PORT berilgan bo'lsa) yoqiladi.
// Background Worker'da PORT bo'lmaydi, shuning uchun server ishga tushmaydi.
if (process.env.PORT) {
  createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot ishlayapti");
  }).listen(process.env.PORT, () =>
    console.log(`🩺 Health-check server ${process.env.PORT}-portda`)
  );
}

// ---------- 9. Ishga tushirish ----------
process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

bot.start({
  // Business hodisalari aniq yoqilgan bo'lishi kerak
  allowed_updates: ["message", "business_connection", "business_message"],
  onStart: (info) =>
    console.log(`🚀 Bot ishga tushdi: @${info.username} | Model: ${MODEL}`),
});