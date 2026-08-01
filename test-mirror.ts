async function checkMirrorNodeSuccess(transactionId: string, iteration: number = 0): Promise<boolean> {
  try {
    const parts = transactionId.split('@');
    if (parts.length !== 2) return false;
    const accountId = parts[0];
    const timestamp = parts[1].replace('.', '-');
    const mirrorId = `${accountId}-${timestamp}`;
    console.log("mirrorId:", mirrorId);
    
    const cacheBusterTimestamp = Math.floor(Date.now() / 1000) - 86400 + iteration;
    const url = `https://testnet.mirrornode.hedera.com/api/v1/transactions?account.id=${accountId}&timestamp=gt:${cacheBusterTimestamp}&limit=15&order=desc`;
    console.log("url:", url);
    
    const response = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (response.ok) {
      const data = await response.json();
      const found = data.transactions?.some((t: any) => {
        if (t.transaction_id === mirrorId) {
          console.log("Found matching tx:", t.transaction_id, "result:", t.result);
        }
        return t.transaction_id === mirrorId && t.result === "SUCCESS";
      });
      console.log("found:", found);
      return found;
    } else {
      console.log("Response not OK:", response.status);
    }
  } catch (error) {
    console.error("Error:", error);
  }
  return false;
}

// Transaction from WalletConnect might be formatted as 0.0.6255888@1785536216.058070117
checkMirrorNodeSuccess("0.0.6255888@1785536216.058070117", 0);
