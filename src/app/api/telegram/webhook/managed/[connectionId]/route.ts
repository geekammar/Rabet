import { handleManagedTelegramWebhookRequest } from "@/lib/telegram/managed-webhook";

export async function POST(
  req: Request,
  context: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const { connectionId } = await context.params;

  return handleManagedTelegramWebhookRequest(req, connectionId);
}
