/**
 * Minimal Telegram Bot API sender, shared by the admin signup
 * notification route. Kept separate from app/api/telegram/route.ts so
 * that route (the incoming webhook) stays untouched.
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
  botToken: string
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed with status ${response.status}`);
  }
}
