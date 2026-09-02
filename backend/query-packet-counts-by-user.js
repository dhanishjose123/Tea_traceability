function normalizeUserId(value) {
  const match = String(value || "").match(/(?:^|\.)(User\d+)$/i);
  return match ? `User${Number(match[1].replace(/User/i, ""))}` : value;
}

async function countPacketsByUser(contract, userId, status = "") {
  const normalizedUserId = normalizeUserId(userId);
  const result = await contract.evaluateTransaction(
    "countPacketsByOwner",
    normalizedUserId,
    status
  );
  const parsed = JSON.parse(result.toString());

  return {
    ownerId: normalizeUserId(parsed.ownerId || normalizedUserId),
    status: String(parsed.status || status || "ALL").toUpperCase(),
    count: Number(parsed.count || 0),
    totalWeightKg: Number(parsed.totalWeightKg || 0)
  };
}

async function countPacketsByUsers(contract, userIds, statuses) {
  const rows = [];

  for (const userId of userIds) {
    for (const status of statuses) {
      try {
        const row = await countPacketsByUser(contract, userId, status);
        console.log(`Packet count owner=${row.ownerId} status=${row.status} count=${row.count}`);
        rows.push(row);
      } catch (error) {
        console.warn(`Packet count owner=${normalizeUserId(userId)} status=${status || "ALL"} failed: ${error.message}`);
        rows.push({
          ownerId: normalizeUserId(userId),
          status: String(status || "ALL").toUpperCase(),
          count: 0,
          totalWeightKg: 0,
          error: error.message
        });
      }
    }
  }

  return rows;
}

module.exports = {
  normalizeUserId,
  countPacketsByUser,
  countPacketsByUsers
};

