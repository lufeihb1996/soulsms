import { getSupabaseAdmin } from "@/lib/supabase";
import { getSms, GrizzlyError, markOrderUsed, rejectOrder } from "@/lib/grizzly";

export interface ExpirableOrder {
  id: string;
  provider_request_id: string;
  expires_at: string;
}

export type ExpiryResult = "waiting" | "received" | "replacement_pending" | "expired" | "unchanged";

function isEarlyCancelDenied(error: unknown) {
  return error instanceof GrizzlyError && error.code === "early_cancel_denied";
}

async function deferRelease(orderId: string) {
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  const { error } = await getSupabaseAdmin()
    .from("sms_orders")
    .update({ can_swap_at: retryAt, expires_at: retryAt, updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .eq("status", "waiting");
  if (error) throw error;
}

export async function checkAndReleaseOrder(order: ExpirableOrder): Promise<ExpiryResult> {
  const supabase = getSupabaseAdmin();
  const sms = await getSms(order.provider_request_id);

  if (sms.code) {
    const { data: completed, error } = await supabase.rpc("complete_sms_order", {
      p_order_id: order.id,
      p_sms_code: sms.code,
    });
    if (error) throw error;
    if (completed !== true) return "unchanged";
    await markOrderUsed(order.provider_request_id).catch(() => undefined);
    return "received";
  }

  if (new Date(order.expires_at).getTime() > Date.now()) return "waiting";

  const { data: swapLocked, error: swapError } = await supabase.rpc("begin_sms_swap", {
    p_order_id: order.id,
  });
  if (swapError) throw swapError;

  if (swapLocked === true) {
    try {
      await rejectOrder(order.provider_request_id);
    } catch (error) {
      await supabase.rpc("rollback_sms_swap", {
        p_order_id: order.id,
        p_status: "waiting",
        p_refund_swap: true,
      });
      if (isEarlyCancelDenied(error)) {
        await deferRelease(order.id);
        return "waiting";
      }
      throw error;
    }

    const { data: released, error: releaseError } = await supabase.rpc("rollback_sms_swap", {
      p_order_id: order.id,
      p_status: "replacement_pending",
      p_refund_swap: false,
    });
    if (releaseError || released !== true) throw releaseError || new Error("旧号码状态更新失败");
    return "replacement_pending";
  }

  const now = new Date().toISOString();
  const { data: locked, error: lockError } = await supabase
    .from("sms_orders")
    .update({ status: "swapping", updated_at: now })
    .eq("id", order.id)
    .eq("status", "waiting")
    .lte("expires_at", now)
    .select("id")
    .maybeSingle();
  if (lockError) throw lockError;
  if (!locked) return "unchanged";

  try {
    await rejectOrder(order.provider_request_id);
  } catch (error) {
    await supabase
      .from("sms_orders")
      .update({ status: "waiting", updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("status", "swapping");
    if (isEarlyCancelDenied(error)) {
      await deferRelease(order.id);
      return "waiting";
    }
    throw error;
  }

  const { error: expireError } = await supabase
    .from("sms_orders")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("id", order.id)
    .eq("status", "swapping");
  if (expireError) throw expireError;
  return "expired";
}
