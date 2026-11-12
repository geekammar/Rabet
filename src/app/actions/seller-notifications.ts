"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  checkSellerNotificationCapability,
  claimTestCooldown,
  getSellerNotificationDelivery,
  listSellerNotificationDeliveries,
  RabetDataError,
  readSellerNotificationConfig,
  recordTestRateLimited,
  recordVerificationSuccess,
  saveSellerNotificationConfig,
  setSellerNotificationEnabled,
  toSafeErrorMessage,
  validatePrivateChatId,
  type SellerNotificationDeliveryRecord,
  type SellerNotificationSettingRecord,
} from "@/lib/data";
import {
  attemptSellerNotificationDelivery,
  getSellerBotMe,
  getSellerBotRecentChats,
  getSellerNotificationBotToken,
  sendSellerTestNotification,
  type BotIdentity,
  type OperatorDetectedChat,
} from "@/lib/telegram/seller-notifications";

export interface SellerNotificationActionResult {
  success: boolean;
  supported?: boolean;
  isTokenConfigured?: boolean;
  config?: SellerNotificationSettingRecord | null;
  bot?: BotIdentity;
  chats?: OperatorDetectedChat[];
  recentDeliveries?: SellerNotificationDeliveryRecord[];
  code?: string;
  message?: string;
  errors?: Record<string, string>;
  remainingSeconds?: number;
}

/**
 * Loads the current seller notification state for the settings dashboard.
 * Requires admin authentication.
 */
export async function loadSellerNotificationStateAction(): Promise<SellerNotificationActionResult> {
  await requireAdmin();

  try {
    const db = getDb();
    const capability = await checkSellerNotificationCapability(db);
    if (!capability.supported) {
      return {
        success: true,
        supported: false,
        message: capability.reason,
        isTokenConfigured: Boolean(getSellerNotificationBotToken()),
      };
    }

    const [config, recentDeliveries] = await Promise.all([
      readSellerNotificationConfig(db),
      listSellerNotificationDeliveries(db, 20),
    ]);

    return {
      success: true,
      supported: true,
      isTokenConfigured: Boolean(getSellerNotificationBotToken()),
      config,
      recentDeliveries,
    };
  } catch (error) {
    return {
      success: false,
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Checks connection to the notification bot via Telegram getMe.
 * Requires admin authentication.
 */
export async function checkNotificationBotConnectionAction(): Promise<SellerNotificationActionResult> {
  await requireAdmin();

  const token = getSellerNotificationBotToken();
  if (!token) {
    return {
      success: false,
      message: "TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN is not configured in hosting environment.",
    };
  }

  const result = await getSellerBotMe(token, 5000);
  if (!result.ok) {
    return {
      success: false,
      message: result.error,
    };
  }

  return {
    success: true,
    bot: result.bot,
    message: `Connected to bot @${result.bot.username || result.bot.id} successfully.`,
  };
}

/**
 * Safe operator helper: fetches recent private chat interactions to discover chat ID.
 * Requires admin authentication.
 */
export async function detectNotificationBotChatsAction(): Promise<SellerNotificationActionResult> {
  await requireAdmin();

  const token = getSellerNotificationBotToken();
  if (!token) {
    return {
      success: false,
      message: "TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN is not configured in hosting environment.",
    };
  }

  const result = await getSellerBotRecentChats(token, 5000);
  if (!result.ok) {
    return {
      success: false,
      message: result.error,
    };
  }

  return {
    success: true,
    chats: result.chats,
  };
}

/**
 * Saves destinationChatId and language.
 * Changing destinationChatId invalidates prior verification and disables notifications.
 * Requires admin authentication.
 */
export async function saveSellerNotificationConfigAction(
  formData: FormData,
): Promise<SellerNotificationActionResult> {
  await requireAdmin();

  const rawDestination = formData.get("destinationChatId");
  const destinationChatId = typeof rawDestination === "string" ? rawDestination.trim() : "";

  const rawLanguage = formData.get("language");
  const language = rawLanguage === "en" ? "en" : "ar";

  if (destinationChatId && !validatePrivateChatId(destinationChatId)) {
    return {
      success: false,
      errors: {
        destinationChatId:
          "Destination chat ID must be a numeric private Telegram chat ID (decimal digits only, e.g. 123456789). Channels, groups, and usernames are not supported.",
      },
      message: "Invalid destination chat ID format.",
    };
  }

  try {
    const db = getDb();
    const config = await saveSellerNotificationConfig(db, {
      destinationChatId: destinationChatId || null,
      language,
    });

    revalidatePath("/settings");

    return {
      success: true,
      config,
      message: "Notification configuration saved successfully.",
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }
    return {
      success: false,
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Sends a TEST notification to the configured destination chat ID and verifies it.
 * Enforces server-side persisted cooldown.
 * Requires admin authentication.
 */
export async function sendSellerTestNotificationAction(): Promise<SellerNotificationActionResult> {
  await requireAdmin();

  try {
    const db = getDb();
    const capability = await checkSellerNotificationCapability(db);
    if (!capability.supported) {
      return {
        success: false,
        message: capability.reason ?? "Database schema upgrade required.",
      };
    }

    const config = await readSellerNotificationConfig(db);
    if (!config?.destinationChatId) {
      return {
        success: false,
        message: "Please configure and save a destination chat ID before testing.",
      };
    }

    const expectedRevision = config.revision;
    const expectedDestination = config.destinationChatId;

    // Persisted rate limiter (5 seconds cooldown)
    const cooldown = await claimTestCooldown(db, 5);
    if (!cooldown.allowed) {
      return {
        success: false,
        remainingSeconds: cooldown.remainingSeconds,
        message: `Please wait ${cooldown.remainingSeconds}s before sending another test notification.`,
      };
    }

    const testRes = await sendSellerTestNotification({
      destinationChatId: expectedDestination,
      language: config.language === "en" ? "en" : "ar",
    });

    if (!testRes.ok) {
      if (testRes.errorKind === "rate_limited") {
        await recordTestRateLimited(db, testRes.retryAfterSeconds ?? 10);
      }
      return {
        success: false,
        message: testRes.error,
      };
    }

    // Persist verified metadata with compare-and-set
    let updated: SellerNotificationSettingRecord;
    try {
      updated = await recordVerificationSuccess(db, {
        botId: testRes.bot.id,
        botUsername: testRes.bot.username,
        expectedRevision,
        expectedDestination,
      });
    } catch (err) {
      if (err instanceof RabetDataError && err.code === "CONFIGURATION_CHANGED") {
        return {
          success: false,
          code: "CONFIGURATION_CHANGED",
          message: "Configuration changed while test was running. Please test again with current settings.",
        };
      }
      throw err;
    }

    revalidatePath("/settings");

    return {
      success: true,
      config: updated,
      bot: testRes.bot,
      message: `Test notification sent successfully (message ID ${testRes.messageId}). Destination and bot verified.`,
    };
  } catch (error) {
    return {
      success: false,
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Enables or disables seller notifications.
 * Verifies that current environment bot token matches verified bot ID before enabling.
 * Requires admin authentication.
 */
export async function toggleSellerNotificationEnabledAction(
  enabled: boolean,
): Promise<SellerNotificationActionResult> {
  await requireAdmin();

  try {
    const db = getDb();
    let currentBotId: number | undefined;

    if (enabled) {
      const token = getSellerNotificationBotToken();
      if (!token) {
        return {
          success: false,
          message: "Cannot enable: TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN is not configured in hosting environment.",
        };
      }
      const meRes = await getSellerBotMe(token, 5000);
      if (!meRes.ok) {
        return {
          success: false,
          message: `Cannot enable: Could not verify bot token with Telegram: ${meRes.error}`,
        };
      }
      currentBotId = meRes.bot.id;
    }

    const updated = await setSellerNotificationEnabled(db, enabled, currentBotId);

    revalidatePath("/settings");

    return {
      success: true,
      config: updated,
      message: enabled ? "Seller notifications enabled." : "Seller notifications disabled.",
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }
    return {
      success: false,
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Manually retries delivery of an eligible seller notification record.
 * Handles duplicate risk acknowledgment for 'unknown' state.
 * Requires admin authentication.
 */
export async function retrySellerNotificationDeliveryAction(
  deliveryId: string,
  options?: { acknowledgeUnknownRisk?: boolean },
): Promise<SellerNotificationActionResult> {
  await requireAdmin();

  if (!deliveryId || typeof deliveryId !== "string") {
    return { success: false, message: "Invalid delivery ID." };
  }

  try {
    const db = getDb();
    const record = await getSellerNotificationDelivery(db, deliveryId);
    if (!record) {
      return { success: false, message: "Delivery record not found." };
    }

    if (record.status === "sent") {
      return { success: false, message: "This notification has already been delivered successfully." };
    }

    if (record.status === "cancelled") {
      return {
        success: false,
        message: "This notification was cancelled due to a configuration or bot identity revision change and cannot be resent.",
      };
    }

    if (record.status === "unknown" && !options?.acknowledgeUnknownRisk) {
      return {
        success: false,
        code: "REQUIRES_UNKNOWN_ACK",
        message: "This notification previously timed out and may have already reached Telegram. Resending might send a duplicate alert. Please confirm acknowledgment to proceed.",
      };
    }

    const result = await attemptSellerNotificationDelivery({
      db,
      deliveryId,
      acknowledgeUnknownRisk: options?.acknowledgeUnknownRisk,
    });

    revalidatePath("/settings");

    if (result.status === "sent") {
      return { success: true, message: `Notification delivered successfully (message ID ${result.messageId}).` };
    }

    if (result.status === "pending") {
      const msg =
        result.reason === "notifications_disabled"
          ? "Notifications are currently disabled. Enable notifications first."
          : `Notification kept pending: ${result.reason}`;
      return { success: false, message: msg };
    }

    if (result.status === "cancelled") {
      return { success: false, message: `Notification cancelled: ${result.reason}` };
    }

    if (result.status === "failed") {
      return {
        success: false,
        message: `Delivery attempt failed (${result.errorCategory})${
          result.retryAfterSeconds ? `. Telegram rate limited, retry after ${result.retryAfterSeconds}s.` : ""
        }`,
      };
    }

    if (result.status === "unknown") {
      return {
        success: false,
        code: "REQUIRES_UNKNOWN_ACK",
        message: "Delivery attempt timed out or network was interrupted; delivery state is unknown.",
      };
    }

    if (result.status === "in_flight") {
      return { success: false, message: "A delivery attempt is currently in flight. Please wait." };
    }

    return { success: false, message: "Delivery remained pending." };
  } catch (error) {
    return { success: false, message: toSafeErrorMessage(error) };
  }
}
