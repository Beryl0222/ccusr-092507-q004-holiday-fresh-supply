// 交收清算计算（纯函数）：以实际交收版本为准，冻结版本只决定优先级。
// 费用行：
//   BASE                    货款 = 实交量 × 承诺价
//   PRICE_ADJUST            退补价 = 实交量 × (结算价 − 承诺价)
//   OVERNIGHT_HANDLING      跨午夜装卸费 = 实交量 × 费率（实际交收时刻与到货窗口不在同一自然日）
//   SHORTFALL_COMPENSATION  短交赔付 = (承诺量 − 实交量) × 费率（应付方向为负）

export const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

function calendarDate(iso, timeZone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function crossesMidnight(window, acceptedAt, timeZone) {
  if (!window?.start || !acceptedAt) return false;
  return calendarDate(window.start, timeZone) !== calendarDate(acceptedAt, timeZone);
}

export function settleDelivery({
  commitment,
  delivery,
  finalPrice = null,
  overnightRate = 0,
  shortfallRate = 0,
  timeZone = "Asia/Shanghai",
}) {
  const committed = Number(commitment.quantity);
  const accepted = Number(delivery.quantity);
  const price = Number(commitment.price);
  if (accepted > committed + 1e-9) {
    throw new Error(`实交量 ${accepted} 超过承诺量 ${committed}`);
  }
  const short = round2(Math.max(0, committed - accepted));
  const lines = [
    {
      type: "BASE",
      quantity: accepted,
      unit_price: price,
      amount: round2(accepted * price),
    },
  ];
  if (short > 1e-9 && shortfallRate > 0) {
    lines.push({
      type: "SHORTFALL_COMPENSATION",
      quantity: short,
      unit_rate: shortfallRate,
      amount: -round2(short * shortfallRate),
    });
  }
  if (finalPrice !== null && Number(finalPrice) !== price) {
    lines.push({
      type: "PRICE_ADJUST",
      quantity: accepted,
      unit_price: round2(Number(finalPrice) - price),
      amount: round2(accepted * (Number(finalPrice) - price)),
    });
  }
  if (crossesMidnight(commitment.arrival_window, delivery.accepted_at, timeZone) && overnightRate > 0) {
    lines.push({
      type: "OVERNIGHT_HANDLING",
      quantity: accepted,
      unit_rate: overnightRate,
      amount: round2(accepted * overnightRate),
    });
  }
  return {
    commitment_id: commitment.commitment_id,
    delivery_id: delivery.delivery_id,
    committed,
    accepted,
    short,
    lines,
    amount: round2(lines.reduce((sum, line) => sum + line.amount, 0)),
  };
}
