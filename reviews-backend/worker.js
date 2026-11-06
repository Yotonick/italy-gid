// Cloudflare Worker для отзывов на сайте Натальи.
//
// Как это работает:
//   1. Гость пишет отзыв на сайте  ->  POST /submit
//   2. Воркер кладёт его в «ожидающие» и шлёт Наталье сообщение в Telegram с кнопками
//      «Одобрить» / «Отклонить»
//   3. Наталья нажимает кнопку  ->  Telegram вызывает POST /telegram
//   4. Одобренный отзыв попадает в список, который сайт читает через GET /approved
//
// Нужны: KV-хранилище REVIEWS и переменные TG_TOKEN, TG_CHAT_ID, TG_SECRET, ALLOW_ORIGIN
// (см. SETUP.md).

const json = (data, status, cors) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // ---- публичный список одобренных отзывов ----
    if (request.method === "GET" && url.pathname === "/approved") {
      const list = JSON.parse((await env.REVIEWS.get("approved")) || "[]");
      return new Response(JSON.stringify(list), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", ...cors },
      });
    }

    // ---- новый отзыв с сайта ----
    if (request.method === "POST" && url.pathname === "/submit") {
      let b;
      try { b = await request.json(); } catch (e) { return json({ ok: false }, 400, cors); }
      if (b.website) return json({ ok: true }, 200, cors); // ловушка для ботов

      const name = String(b.name || "").trim().slice(0, 60);
      const text = String(b.text || "").trim().slice(0, 1000);
      const rating = Math.min(5, Math.max(0, parseInt(b.rating, 10) || 0));
      if (!name || text.length < 10) return json({ ok: false, error: "invalid" }, 400, cors);

      // не чаще одного отзыва в минуту с одного адреса
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (await env.REVIEWS.get("ip:" + ip)) return json({ ok: false, error: "slow_down" }, 429, cors);
      await env.REVIEWS.put("ip:" + ip, "1", { expirationTtl: 60 });

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const review = { id, name, text, rating, date: new Date().toISOString() };
      await env.REVIEWS.put("p:" + id, JSON.stringify(review), { expirationTtl: 60 * 60 * 24 * 60 });

      const stars = rating ? "★".repeat(rating) + "☆".repeat(5 - rating) + "\n" : "";
      const sent = await tg(env, "sendMessage", {
        chat_id: env.TG_CHAT_ID,
        parse_mode: "HTML",
        text: `📝 <b>Новый отзыв</b>\n${stars}<b>${esc(name)}</b>\n\n${esc(text)}`,
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Одобрить", callback_data: "a:" + id },
            { text: "❌ Отклонить", callback_data: "r:" + id },
          ]],
        },
      });
      if (!sent.ok) return json({ ok: false, error: "telegram" }, 502, cors);
      return json({ ok: true }, 200, cors);
    }

    // ---- нажатие кнопки в Telegram ----
    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const upd = await request.json();
      const cq = upd.callback_query;
      if (!cq) return new Response("ok");

      // решения принимает только Наталья
      if (String(cq.from && cq.from.id) !== String(env.TG_CHAT_ID)) {
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Нет доступа" });
        return new Response("ok");
      }

      const [action, id] = String(cq.data || "").split(":");
      const key = "p:" + id;
      const raw = await env.REVIEWS.get(key);
      const msg = cq.message;
      if (!raw) {
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Этот отзыв уже обработан" });
        return new Response("ok");
      }
      const review = JSON.parse(raw);
      let label;
      if (action === "a") {
        const list = JSON.parse((await env.REVIEWS.get("approved")) || "[]");
        list.unshift({ name: review.name, text: review.text, rating: review.rating, date: review.date });
        await env.REVIEWS.put("approved", JSON.stringify(list.slice(0, 200)));
        label = "✅ Одобрено, отзыв на сайте";
      } else {
        label = "❌ Отклонено";
      }
      await env.REVIEWS.delete(key);
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: label });
      if (msg) {
        const stars = review.rating ? "★".repeat(review.rating) + "☆".repeat(5 - review.rating) + "\n" : "";
        await tg(env, "editMessageText", {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "HTML",
          text: `${label}\n${stars}<b>${esc(review.name)}</b>\n\n${esc(review.text)}`,
        });
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};
