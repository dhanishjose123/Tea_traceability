const DEFAULT_LIMIT = Math.max(1, Number(process.env.PACKET_QUERY_LIMIT || 5000));

function normalizeUserId(value) {
  const match = String(value || "").match(/(?:^|\.)(User\d+)$/i);
  return match ? `User${Number(match[1].replace(/User/i, ""))}` : value;
}

async function queryPacketsByUser(contract, userId, status = "", limit = DEFAULT_LIMIT) {
  const normalizedUserId = normalizeUserId(userId);
  const result = await contract.evaluateTransaction(
    "getAllPacketsByRetailer",
    normalizedUserId,
    status,
    String(limit)
  );
  const packets = JSON.parse(result.toString());
  return Array.isArray(packets) ? packets : [];
}

async function queryPacketsByUsers(contract, userIds, statuses, limit = DEFAULT_LIMIT) {
  const packetsById = new Map();

  for (const userId of userIds) {
    for (const status of statuses) {
      try {
        const packets = await queryPacketsByUser(contract, userId, status, limit);
        console.log(`Packet query owner=${normalizeUserId(userId)} status=${status || "ALL"} returned ${packets.length}`);

        for (const packet of packets) {
          packetsById.set(packet.packetId || JSON.stringify(packet), packet);
        }
      } catch (error) {
        console.warn(`Packet query owner=${normalizeUserId(userId)} status=${status || "ALL"} failed: ${error.message}`);
      }
    }
  }

  return Array.from(packetsById.values());
}

module.exports = {
  normalizeUserId,
  queryPacketsByUser,
  queryPacketsByUsers
};

