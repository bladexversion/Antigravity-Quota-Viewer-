// ── API Communication Layer ──

export async function getUsageData(signal) {
  const res = await fetch("/api/usage", {
    signal: signal || AbortSignal.timeout(6000),
    cache: "no-store"
  });
  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}`);
  }
  return await res.json();
}

export async function triggerRefresh() {
  try {
    const res = await fetch("/api/refresh", {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      cache: "no-store"
    });
    if (res.ok) return await res.json();
  } catch (err) {
    // If POST isn't supported or fails, fallback to GET /api/usage
  }
  return await getUsageData();
}

export async function deleteAccount(email) {
  const res = await fetch(`/api/usage/${encodeURIComponent(email)}`, {
    method: "DELETE",
    headers: {
      "X-Agquota": "1"
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to forget account (HTTP ${res.status})`);
  }
  return await res.json();
}
