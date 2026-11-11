// Cloudflare Worker для отзывов на сайте Натальи.
//
// Как это работает:
//   1. Гость пишет отзыв на сайте (оценка звёздами обязательна)  ->  POST /submit
//   2. Воркер кладёт его в «ожидающие» и шлёт Наталье сообщение в Telegram
//      с кнопками «Одобрить» / «Отклонить»
//   3. После «Одобрить» отзыв попадает на сайт (GET /approved), а под сообщением
//      появляется кнопка «Удалить с сайта»
//   4. Команда /reviews в чате с ботом показывает все опубликованные отзывы,
//      у каждого есть кнопка «Удалить с сайта»
//
// Нужны: KV-хранилище REVIEWS и переменные TG_TOKEN, TG_CHAT_ID, TG_SECRET, ALLOW_ORIGIN
// (см. SETUP.md).

const json = (data, status, cors) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const starsLine = (n) => (n ? "★".repeat(n) + "☆".repeat(5 - n) + "\n" : "");
const reviewText = (head, r) => `${head}\n${starsLine(r.rating)}<b>${esc(r.name)}</b>\n\n${esc(r.text)}`;
const delKeyboard = (r) => ({ inline_keyboard: [[{ text: "🗑 Удалить с сайта", callback_data: "d:" + r.date }]] });

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function sha(t) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const getApproved = async (env) => JSON.parse((await env.REVIEWS.get("approved")) || "[]");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/{2,}/g, "/"); // терпим двойные слэши
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // ---- публичный список одобренных отзывов ----
    if (request.method === "GET" && path === "/approved") {
      return new Response(JSON.stringify(await getApproved(env)), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", ...cors },
      });
    }

    // ---- новый отзыв с сайта ----
    if (request.method === "POST" && path === "/submit") {
      let b;
      try { b = await request.json(); } catch (e) { return json({ ok: false }, 400, cors); }
      if (b.website) return json({ ok: true }, 200, cors); // ловушка для ботов

      const name = String(b.name || "").trim().slice(0, 60);
      const text = String(b.text || "").trim().slice(0, 1000);
      const rating = parseInt(b.rating, 10) || 0;
      if (!name || text.length < 10 || rating < 1 || rating > 5) return json({ ok: false, error: "invalid" }, 400, cors);

      // Защита от спама. Метки ставим только ПОСЛЕ успешной отправки в Telegram,
      // чтобы неудачная попытка не блокировала следующую.
      //  - dup:  тот же отзыв (адрес + имя + текст) повторно за 10 минут -> «уже отправлен»
      //  - rl:   не больше 3 отзывов за 10 минут с одного адреса (дома/в мобильной сети
      //          один адрес часто делят несколько устройств и людей)
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const dupKey = "dup:" + (await sha(ip + "|" + name.toLowerCase() + "|" + text.toLowerCase()));
      const rlKey = "rl:" + ip;
      if (await env.REVIEWS.get(dupKey)) return json({ ok: true, duplicate: true }, 200, cors);
      const count = parseInt((await env.REVIEWS.get(rlKey)) || "0", 10);
      if (count >= 3) return json({ ok: false, error: "slow_down" }, 429, cors);

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const review = { id, name, text, rating, date: new Date().toISOString() };

      let sent;
      try {
        sent = await tg(env, "sendMessage", {
          chat_id: env.TG_CHAT_ID,
          parse_mode: "HTML",
          text: reviewText("📝 <b>Новый отзыв</b>", review),
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Одобрить", callback_data: "a:" + id },
              { text: "❌ Отклонить", callback_data: "r:" + id },
            ]],
          },
        });
      } catch (e) {
        sent = { ok: false, description: String(e && e.message || e) };
      }
      if (!sent.ok) {
        console.log("telegram error:", JSON.stringify(sent));
        return json({ ok: false, error: "telegram", detail: sent.description || "" }, 502, cors);
      }

      await env.REVIEWS.put("p:" + id, JSON.stringify(review), { expirationTtl: 60 * 60 * 24 * 60 });
      await env.REVIEWS.put(dupKey, "1", { expirationTtl: 600 });
      await env.REVIEWS.put(rlKey, String(count + 1), { expirationTtl: 600 });
      return json({ ok: true }, 200, cors);
    }

    // ---- проверка настроек: откройте /health в браузере ----
    if (request.method === "GET" && path === "/health") {
      const out = { worker: true, kv: false, token: false, chat: false, webhook: null, errors: [] };
      try { await env.REVIEWS.get("approved"); out.kv = true; } catch (e) { out.errors.push("KV: привязка REVIEWS не найдена"); }
      if (!env.TG_TOKEN) out.errors.push("Нет переменной TG_TOKEN");
      if (!env.TG_CHAT_ID) out.errors.push("Нет переменной TG_CHAT_ID");
      if (env.TG_TOKEN) {
        try {
          const me = await tg(env, "getMe", {});
          out.token = !!me.ok; if (!me.ok) out.errors.push("Токен бота: " + (me.description || "не принят"));
          if (me.ok && env.TG_CHAT_ID) {
            const ch = await tg(env, "getChat", { chat_id: env.TG_CHAT_ID });
            out.chat = !!ch.ok; if (!ch.ok) out.errors.push("Чат: " + (ch.description || "не найден") + " (напишите боту /start с нужного аккаунта и проверьте TG_CHAT_ID)");
          }
          const wh = await tg(env, "getWebhookInfo", {});
          if (wh.ok) out.webhook = wh.result.url ? (wh.result.last_error_message ? "ошибка: " + wh.result.last_error_message : "ок") : "не установлен";
        } catch (e) { out.errors.push("Telegram недоступен: " + (e && e.message || e)); }
      }
      out.allow_origin = env.ALLOW_ORIGIN || "*";
      return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
    }

    // ---- события из Telegram ----
    if (request.method === "POST" && path === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const upd = await request.json();
      const owner = String(env.TG_CHAT_ID);

      // --- команды в чате с ботом ---
      if (upd.message) {
        const m = upd.message;
        if (String(m.from && m.from.id) !== owner) return new Response("ok");
        const cmd = String(m.text || "").split(/[\s@]/)[0].toLowerCase();
        if (cmd === "/reviews" || cmd === "/list") {
          const list = await getApproved(env);
          if (!list.length) {
            await tg(env, "sendMessage", { chat_id: owner, text: "На сайте пока нет опубликованных отзывов." });
          } else {
            await tg(env, "sendMessage", { chat_id: owner, text: `Опубликовано отзывов: ${list.length}. Показываю последние ${Math.min(list.length, 20)}.` });
            for (const r of list.slice(0, 20)) {
              await tg(env, "sendMessage", {
                chat_id: owner, parse_mode: "HTML",
                text: reviewText("🌐 <b>На сайте</b>", r), reply_markup: delKeyboard(r),
              });
            }
          }
        } else if (cmd === "/start" || cmd === "/help") {
          await tg(env, "sendMessage", { chat_id: owner, text: "Я присылаю новые отзывы с сайта на проверку.\n/reviews — показать опубликованные отзывы и удалить лишние." });
        }
        return new Response("ok");
      }

      // --- нажатия на кнопки ---
      const cq = upd.callback_query;
      if (!cq) return new Response("ok");
      if (String(cq.from && cq.from.id) !== owner) {
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Нет доступа" });
        return new Response("ok");
      }
      const data = String(cq.data || "");
      const action = data.charAt(0);
      const id = data.slice(2);
      const msg = cq.message;
      const edit = (text, markup) =>
        msg && tg(env, "editMessageText", {
          chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: "HTML", text,
          ...(markup ? { reply_markup: markup } : {}),
        });

      // удалить уже опубликованный отзыв (id здесь = дата отзыва)
      if (action === "d") {
        const list = await getApproved(env);
        const found = list.find((r) => r.date === id);
        if (!found) {
          await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Этот отзыв уже удалён" });
          if (msg) await tg(env, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
          return new Response("ok");
        }
        await env.REVIEWS.put("approved", JSON.stringify(list.filter((r) => r.date !== id)));
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "🗑 Удалено с сайта" });
        await edit(reviewText("🗑 Удалено с сайта", found));
        return new Response("ok");
      }

      // одобрить / отклонить ожидающий отзыв
      const key = "p:" + id;
      const raw = await env.REVIEWS.get(key);
      if (!raw) {
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Этот отзыв уже обработан" });
        return new Response("ok");
      }
      const review = JSON.parse(raw);
      if (action === "a") {
        const list = await getApproved(env);
        const pub = { name: review.name, text: review.text, rating: review.rating, date: review.date };
        list.unshift(pub);
        await env.REVIEWS.put("approved", JSON.stringify(list.slice(0, 200)));
        await env.REVIEWS.delete(key);
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "✅ Одобрено, отзыв на сайте" });
        await edit(reviewText("✅ Одобрено, отзыв на сайте", review), delKeyboard(pub));
      } else {
        await env.REVIEWS.delete(key);
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "❌ Отклонено" });
        await edit(reviewText("❌ Отклонено", review));
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};
