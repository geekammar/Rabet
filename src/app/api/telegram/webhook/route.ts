import { handleTelegramWebhookRequest } from "@/lib/telegram/webhook";

export async function POST(req: Request): Promise<Response> {
  return handleTelegramWebhookRequest(req);
}
