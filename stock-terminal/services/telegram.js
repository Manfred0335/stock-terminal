/* =====================================================================
   Telegram delivery — native fetch, no dependency.
   Bot token + chat id come from config (env or set via the dashboard).
   ===================================================================== */
'use strict';

async function sendMessage(botToken, chatId, text) {
  if (!botToken || !chatId) throw new Error('Telegram not configured (missing bot token or chat id)');
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram error: ' + (j.description || r.status));
  return j.result;
}

// Auto-discover the chat id from recent messages to the bot (so the user only
// needs to provide the token and send the bot any message once).
async function detectChatId(botToken) {
  if (!botToken) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`);
    const j = await r.json();
    if (!j.ok || !Array.isArray(j.result)) return null;
    for (let i = j.result.length - 1; i >= 0; i--) {
      const u = j.result[i];
      const chat = (u.message || u.edited_message || u.channel_post || {}).chat;
      if (chat && chat.id != null) return String(chat.id);
    }
  } catch (e) {}
  return null;
}

module.exports = { sendMessage, detectChatId };
