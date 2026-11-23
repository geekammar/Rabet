import { handleManagerTelegramWebhookRequest } from "@/lib/telegram/manager-webhook";

export async function POST(req: Request): Promise<Response> {
  return handleManagerTelegramWebhookRequest(req);
}
